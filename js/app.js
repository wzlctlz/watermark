/**
 * app.js - 主应用逻辑
 * 浏览器端批量照片水印工具
 * 单列布局：照片列表(含选择按钮)→统计→配置→操作→日志
 */

// ===== 高德 Web 服务 Key（硬编码，避免用户手动输入）=====
// 用于逆地理编码（坐标→地址）和静态地图加载
const AMAP_WEB_KEY = '1b67b1cda76952d5d05398af1dc1ba3e'

// 应用版本（与调试导出 schema 对应）
const APP_VERSION = 'v2026-08-17-grid'

// ===== 全局状态 =====
const state = {
  files: [],
  exifData: new Map(),
  processed: new Map(),
  currentLocation: null,
  processing: false,
  mapCache: new Map(),
  startTime: null,
  // 统一水印数据（从一张照片加载，所有照片共用）
  sharedMapImg: null,
  sharedWgsLng: null,
  sharedWgsLat: null,
  sharedGcjLng: null,
  sharedGcjLat: null,
  sharedAddress: null,
  // 照片选择模式
  selectMode: false,
  selectedIdx: -1,
}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', function() {
  log('水印相机 ' + APP_VERSION + ' (网格加号/蓝紫进度条/玻璃拟态版)', 'ok')
  console.log('[水印相机] 版本: ' + APP_VERSION)
  captureEnvironment()
  initTheme()
  setupDragDrop()
  setupFileInputs()
  loadSavedConfig()
  // 全局错误捕获（任何未捕获异常都进入调试记录，便于事后定位）
  window.addEventListener('error', function (ev) {
    if (typeof WMLog === 'function') {
      WMLog('err', '[全局异常] ' + (ev.message || 'unknown') + (ev.filename ? ' @ ' + ev.filename + ':' + ev.lineno : ''), 'global')
      if (typeof WMEvent === 'function') WMEvent('uncaught-error', { message: ev.message, file: ev.filename, line: ev.lineno, col: ev.colno })
    }
  })
  window.addEventListener('unhandledrejection', function (ev) {
    if (typeof WMLog === 'function') {
      var r = ev.reason
      WMLog('err', '[未处理的Promise拒绝] ' + (r && r.message ? r.message : String(r)), 'global')
      if (typeof WMEvent === 'function') WMEvent('unhandled-rejection', { message: r && r.message ? r.message : String(r) })
    }
  })
})

// ===== 实时性能阶段显示（WMPerf 每完成一个阶段回调）=====
// 在进度区实时显示「当前刚完成的阶段 + 耗时」，方便现场观察哪一步在卡/发热
window.onWMPerfStage = function (key, name, ms, rec) {
  try {
    var el = document.getElementById('perfLive')
    if (!el) return
    // 去掉前缀 [fs..] / [jpegjs] 仅用于展示清晰
    var label = name.replace(/^\[[^\]]*\]\s*/, '')
    var heap = (rec && rec.heapMB != null) ? ('  堆:' + rec.heapMB + 'MB') : ''
    el.textContent = label + ' 完成 ' + ms + 'ms' + heap
  } catch (e) {}
}

// ===== 主题：明暗 / 跟随系统 =====
function getStoredTheme() {
  try { return localStorage.getItem('wm-theme') || 'system' } catch (e) { return 'system' }
}
function applyTheme() {
  var theme = getStoredTheme()
  var sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  var isDark = theme === 'dark' || (theme === 'system' && sysDark)
  document.documentElement.classList.toggle('dark', isDark)
  document.documentElement.setAttribute('data-theme', theme)
  updateThemeIcon(theme, isDark)
}
// 主题循环：system → light → dark → system
function cycleTheme() {
  var cur = getStoredTheme()
  var next = cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system'
  try { localStorage.setItem('wm-theme', next) } catch (e) {}
  applyTheme()
}
function updateThemeIcon(theme, isDark) {
  var icon = document.getElementById('themeIcon')
  var label = document.getElementById('themeLabel')
  if (icon) icon.textContent = theme === 'system' ? '🌐' : isDark ? '🌙' : '☀️'
  if (label) label.textContent = theme === 'system' ? '跟随系统' : (isDark ? '夜间' : '日间')
}
function initTheme() {
  applyTheme()
  var mq = window.matchMedia('(prefers-color-scheme: dark)')
  var handler = function() { if (getStoredTheme() === 'system') applyTheme() }
  if (mq.addEventListener) mq.addEventListener('change', handler)
  else if (mq.addListener) mq.addListener(handler)
}

// ===== 拖拽支持 =====
function setupDragDrop() {
  var body = document.body
  body.addEventListener('dragover', function(e) { e.preventDefault() })
  body.addEventListener('drop', function(e) {
    e.preventDefault()
    handleDroppedFiles(e.dataTransfer)
  })
}

function handleDroppedFiles(dataTransfer) {
  var files = []
  var promises = []

  if (dataTransfer.items) {
    for (var i = 0; i < dataTransfer.items.length; i++) {
      var item = dataTransfer.items[i]
      if (item.kind === 'file') {
        var entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null
        if (entry && entry.isDirectory) {
          promises.push(readDirectoryRecursive(entry).then(function(f) { files.push.apply(files, f) }))
        } else {
          var f = item.getAsFile()
          if (f && isImageFile(f)) files.push(f)
        }
      }
    }
  } else {
    for (var j = 0; j < dataTransfer.files.length; j++) {
      if (isImageFile(dataTransfer.files[j])) files.push(dataTransfer.files[j])
    }
  }

  if (promises.length > 0) {
    Promise.all(promises).then(function() { addFiles(files) })
  } else {
    addFiles(files)
  }
}

function readDirectoryRecursive(dirEntry) {
  return new Promise(function(resolve) {
    var reader = dirEntry.createReader()
    var allFiles = []

    function readBatch() {
      reader.readEntries(function(entries) {
        if (entries.length === 0) { resolve(allFiles); return }
        var subPromises = []
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isFile) {
            subPromises.push(new Promise(function(r) { entries[i].file(function(f) { r(f) }) }).then(function(file) {
              if (isImageFile(file)) allFiles.push(file)
            }))
          } else if (entries[i].isDirectory) {
            subPromises.push(readDirectoryRecursive(entries[i]).then(function(f) { allFiles.push.apply(allFiles, f) }))
          }
        }
        Promise.all(subPromises).then(readBatch)
      })
    }
    readBatch()
  })
}

function isImageFile(file) {
  if (!file) return false
  if (file.type === 'image/jpeg' || file.type === 'image/png') return true
  var name = (file.name || '').toLowerCase()
  return name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png')
}

// ===== 文件输入 =====
// 使用单个 input accept="image/*"：iOS/Android 会同时提供“拍照”与“相册”选项，并返回原图（含 GPS EXIF）
function setupFileInputs() {
  var fileInput = document.getElementById('fileInput')
  if (fileInput) {
    fileInput.addEventListener('change', function(e) {
      var files = Array.from(e.target.files).filter(isImageFile)
      if (files.length > 0) addFiles(files)
      e.target.value = ''
    })
  }
}

// ===== 添加文件 =====
async function addFiles(newFiles) {
  var existingNames = new Set(state.files.map(function(f) { return f.name + '_' + f.size }))
  var unique = newFiles.filter(function(f) { return !existingNames.has(f.name + '_' + f.size) })

  if (unique.length === 0) {
    showToast('没有新的照片可添加')
    return
  }

  log('[添加文件] 收到 ' + newFiles.length + ' 张，新增 ' + unique.length + ' 张', 'ok')
  state.files.push.apply(state.files, unique)

  for (var i = 0; i < unique.length; i++) {
    var f = unique[i]
    log('  读取EXIF: ' + f.name + ' (' + Math.round(f.size / 1024) + 'KB)')
    try {
      var exifResult = await ExifUtils.readExif(f)
      // 同时读取图片原始宽高
      try {
        var bmp = await createImageBitmap(f)
        exifResult.imgWidth = bmp.width
        exifResult.imgHeight = bmp.height
        bmp.close()
      } catch (e2) {
        exifResult.imgWidth = 0
        exifResult.imgHeight = 0
      }
      state.exifData.set(f.name + '_' + f.size, exifResult)
      var gpsInfo = exifResult && exifResult.gps
        ? 'GPS OK WGS84(' + exifResult.gps.lat.toFixed(6) + ',' + exifResult.gps.lng.toFixed(6) + ')'
        : '无GPS'
      log('    EXIF: ' + gpsInfo + (exifResult && exifResult.date ? ' | 日期:' + exifResult.date : ''), exifResult && exifResult.gps ? 'ok' : 'warn')
    } catch (e) {
      log('    EXIF读取失败: ' + e.message, 'err')
      state.exifData.set(f.name + '_' + f.size, null)
    }
  }

  // 自动提取GPS坐标：若尚未有共享坐标，从第一张有GPS的照片中提取
  if (!state.sharedWgsLng || !state.sharedWgsLat) {
    for (var i = 0; i < unique.length; i++) {
      var key = unique[i].name + '_' + unique[i].size
      var exif = state.exifData.get(key)
      if (exif && exif.gps && exif.gps.lat && exif.gps.lng) {
        state.sharedWgsLng = exif.gps.lng
        state.sharedWgsLat = exif.gps.lat
        state.sharedAddress = null
        log('[自动提取坐标] 从 ' + unique[i].name + ' 提取 WGS84(' + exif.gps.lat.toFixed(6) + ',' + exif.gps.lng.toFixed(6) + ')', 'ok')
        // 同时逆地理编码
        reverseGeocodeWgs84(exif.gps.lat, exif.gps.lng)
        break
      }
    }
  }

  updateUI()
  showToast('已添加 ' + unique.length + ' 张照片')
}

// ===== WGS84逆地理编码（先转GCJ02再请求高德）=====
function reverseGeocodeWgs84(wgsLat, wgsLng) {
  var gcj = CoordTransform.wgs84ToGcj02(wgsLng, wgsLat)
  var amapKey = AMAP_WEB_KEY
  if (!amapKey) return
  reverseGeocode(gcj.lng, gcj.lat, amapKey).then(function(addr) {
    state.sharedAddress = addr
    document.getElementById('address').value = addr || ''
    log('[逆地理编码] ' + addr, 'ok')
    updateUI()
  }).catch(function(e) {
    log('[逆地理编码] 失败: ' + e.message, 'warn')
  })
}

// ===== 分辨率标识计算 =====
// 长边 / 1000 取整：0→未知 1→1K 2→2K 4→4K 8→8K 以上→1M
function getResBadge(exif) {
  if (!exif) return null
  var w = exif.imgWidth || 0
  var h = exif.imgHeight || 0
  if (!w && !h) return null
  var longEdge = Math.max(w, h)
  var level = Math.floor(longEdge / 1000)
  if (level <= 0) return null
  var labels = {
    1: { text: '1K', color: '#64748b' },
    2: { text: '2K', color: '#3b82f6' },
    3: { text: '3K', color: '#8b5cf6' },
    4: { text: '4K', color: '#10b981' },
    5: { text: '5K', color: '#10b981' },
    6: { text: '6K', color: '#f59e0b' },
    7: { text: '7K', color: '#f59e0b' },
    8: { text: '8K', color: '#ef4444' },
  }
  if (level >= 9) return { text: '1M', color: '#dc2626' }
  return labels[level] || { text: level + 'K', color: '#64748b' }
}

// ===== dataURL → Blob（释放 base64 字符串内存）=====
function dataUrlToBlob(dataUrl) {
  var parts = dataUrl.split(',')
  var mime = parts[0].match(/:(.*?);/)[1]
  var byteString = atob(parts[1])
  var ab = new ArrayBuffer(byteString.length)
  var ia = new Uint8Array(ab)
  for (var i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i)
  }
  return new Blob([ab], { type: mime })
}

// ===== Blob → dataURL（临时，用于 piexif EXIF 注入）=====
function blobToDataUrl(blob) {
  return new Promise(function(resolve) {
    var reader = new FileReader()
    reader.onloadend = function() { resolve(reader.result) }
    reader.onerror = function() { resolve(null) }
    reader.readAsDataURL(blob)
  })
}

// ===== 缩放输入图片（仅在原图处理失败时降级使用）=====
function scaleInput(input, maxDim) {
  var w = input.naturalWidth || input.width || 0
  var h = input.naturalHeight || input.height || 0
  if (!w || !h || (w <= maxDim && h <= maxDim)) return input

  var scale = maxDim / Math.max(w, h)
  var sW = Math.round(w * scale)
  var sH = Math.round(h * scale)

  var canvas = document.createElement('canvas')
  canvas.width = sW
  canvas.height = sH
  var ctx = canvas.getContext('2d')
  ctx.drawImage(input, 0, 0, sW, sH)

  // 释放 ImageBitmap
  if (typeof input.close === 'function') input.close()

  return canvas
}

// ===== 更新 UI =====
function updateUI() {
  var grid = document.getElementById('photoGrid')
  var photoEmpty = document.getElementById('photoEmpty')

  var gpsCount = 0, noGpsCount = 0, doneCount = 0
  state.files.forEach(function(f) {
    var key = f.name + '_' + f.size
    var exif = state.exifData.get(key)
    if (exif && exif.gps) gpsCount++
    else noGpsCount++
    if (state.processed.has(key)) doneCount++
  })

  document.getElementById('statTotal').textContent = state.files.length
  document.getElementById('statGps').textContent = gpsCount
  document.getElementById('statNoGps').textContent = noGpsCount
  document.getElementById('statDone').textContent = doneCount

  // 保留加号格引用，重建时始终把它放到最后
  var addCell = document.getElementById('addCell')
  if (addCell && addCell.parentNode) addCell.parentNode.removeChild(addCell)

  if (state.files.length === 0) {
    grid.innerHTML = ''
    if (addCell) grid.appendChild(addCell)
    photoEmpty.style.display = ''
    document.getElementById('downloadBtn').disabled = true
    return
  }

  photoEmpty.style.display = 'none'
  grid.innerHTML = ''
  state.files.forEach(function(file, idx) {
    var key = file.name + '_' + file.size
    var exif = state.exifData.get(key)
    var isProcessed = state.processed.has(key)

    var item = document.createElement('div')
    item.className = 'photo-item'
    if (state.selectMode) item.className += ' select-mode'
    if (idx === state.selectedIdx) item.className += ' selected'

    var thumbUrl = URL.createObjectURL(file)
    var badgeHtml = isProcessed
      ? '<span class="badge badge-done">✓</span>'
      : (exif && exif.gps ? '<span class="badge badge-gps">GPS</span>' : '<span class="badge badge-nogps">无GPS</span>')

    var resBadge = getResBadge(exif)
    var resBadgeHtml = resBadge
      ? '<span class="badge badge-res" style="background:' + resBadge.color + '">' + resBadge.text + '</span>'
      : ''

    item.innerHTML = '<img src="' + thumbUrl + '" loading="lazy" alt="' + file.name + '">'
      + badgeHtml + resBadgeHtml
      + '<div class="filename">' + file.name + '</div>'

    // 删除按钮（右上角）—— 用文件对象做唯一标识，避免索引在删除后错位
    var deleteBtn = document.createElement('button')
    deleteBtn.className = 'btn-delete'
    deleteBtn.textContent = '×'
    deleteBtn.title = '删除此照片'
    deleteBtn.addEventListener('pointerdown', function(e) {
      e.preventDefault()
      e.stopPropagation()
      // 通过文件引用找到当前索引，避免闭包捕获的索引过期
      var currentIdx = state.files.indexOf(file)
      if (currentIdx >= 0) removePhoto(currentIdx)
    })
    deleteBtn.addEventListener('click', function(e) {
      e.preventDefault()
      e.stopPropagation()
      var currentIdx = state.files.indexOf(file)
      if (currentIdx >= 0) removePhoto(currentIdx)
    })
    item.appendChild(deleteBtn)
    if (state.selectMode) {
      item.addEventListener('click', function() { selectPhotoForInfo(idx) })
    } else {
      item.addEventListener('click', function() { showPreview(file, exif, isProcessed) })
    }
    grid.appendChild(item)
  })
  if (addCell) grid.appendChild(addCell)
}

// ===== 删除照片 =====
function removePhoto(idx) {
  if (idx < 0 || idx >= state.files.length) return
  var key = state.files[idx].name + '_' + state.files[idx].size
  state.exifData.delete(key)
  var processedObj = state.processed.get(key)
  if (processedObj && processedObj.blobUrl) URL.revokeObjectURL(processedObj.blobUrl)
  state.processed.delete(key)
  state.files.splice(idx, 1)
  if (state.selectedIdx === idx) state.selectedIdx = -1
  if (state.selectedIdx > idx) state.selectedIdx--
  log('[删除照片] 已删除第 ' + (idx + 1) + ' 张', 'ok')
  updateUI()
}

// ===== 预览 =====
function showPreview(file, exif, isProcessed) {
  var key = file.name + '_' + file.size
  var modal = document.getElementById('previewModal')
  var img = document.getElementById('previewImg')
  var info = document.getElementById('previewInfo')

  if (isProcessed) {
    var processedObj = state.processed.get(key)
    img.src = processedObj ? processedObj.blobUrl : URL.createObjectURL(file)
  } else {
    img.src = URL.createObjectURL(file)
  }

  var infoHtml = ''
  // 文件大小（MB）
  infoHtml += '<span>📦 ' + (file.size / (1024 * 1024)).toFixed(2) + ' MB</span>'
  // 分辨率
  var resBadge = getResBadge(exif)
  if (resBadge) {
    var w = exif.imgWidth || 0
    var h = exif.imgHeight || 0
    infoHtml += '<span>🖼 ' + resBadge.text + (w && h ? ' (' + w + '×' + h + ')' : '') + '</span>'
  }
  if (exif && exif.gps) {
    infoHtml += '<span>📍 WGS84: ' + exif.gps.lat.toFixed(6) + ', ' + exif.gps.lng.toFixed(6) + '</span>'
  }
  if (exif && exif.date) {
    infoHtml += '<span>📅 ' + exif.date + '</span>'
  }
  info.innerHTML = infoHtml

  modal.classList.add('active')
}

function closePreview() {
  document.getElementById('previewModal').classList.remove('active')
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    closePreview()
    if (state.selectMode) {
      state.selectMode = false
      updateUI()
    }
  }
})

// ===== 加载照片信息（统一水印） =====
async function loadPhotoInfo() {
  if (state.files.length === 0) {
    showToast('请先添加照片')
    return
  }

  // 切换选择模式
  state.selectMode = !state.selectMode
  if (state.selectMode) {
    state.selectedIdx = -1
    showToast('请在照片列表中点选一张照片')
  }
  updateUI()
}

async function selectPhotoForInfo(idx) {
  var file = state.files[idx]
  var key = file.name + '_' + file.size
  var exifResult = state.exifData.get(key)
  var gps = exifResult && exifResult.gps ? exifResult.gps : null
  var amapKey = AMAP_WEB_KEY

  // 标记选中
  state.selectedIdx = idx
  updateUI()

  log('[加载照片信息] 选择: ' + file.name, 'ok')

  if (!gps) {
    // 尝试浏览器定位
    log('[加载照片信息] 照片无EXIF GPS，尝试浏览器定位...', 'warn')
    try {
      var geoPos = await new Promise(function(resolve, reject) {
        if (!navigator.geolocation) { reject(new Error('浏览器不支持定位')); return }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true, timeout: 10000, maximumAge: 60000
        })
      })
      var wgsLng = geoPos.coords.longitude
      var wgsLat = geoPos.coords.latitude
      var gcj = CoordTransform.wgs84ToGcj02(wgsLng, wgsLat)
      state.sharedWgsLng = wgsLng
      state.sharedWgsLat = wgsLat
      state.sharedGcjLng = gcj.lng
      state.sharedGcjLat = gcj.lat
      log('[加载照片信息] 浏览器定位 GCJ02(' + gcj.lng.toFixed(6) + ',' + gcj.lat.toFixed(6) + ')', 'ok')
    } catch (e) {
      state.sharedWgsLng = state.sharedWgsLat = state.sharedGcjLng = state.sharedGcjLat = null
      log('[加载照片信息] 浏览器定位也失败: ' + e.message, 'err')
      showToast('无GPS信息，请选择有GPS的照片')
      state.selectMode = false
      updateUI()
      return
    }
  } else {
    state.sharedWgsLng = gps.lng
    state.sharedWgsLat = gps.lat
    var gcj = CoordTransform.wgs84ToGcj02(gps.lng, gps.lat)
    state.sharedGcjLng = gcj.lng
    state.sharedGcjLat = gcj.lat
    log('[加载照片信息] EXIF GPS → GCJ02(' + gcj.lng.toFixed(6) + ',' + gcj.lat.toFixed(6) + ')', 'ok')
  }

  // 填充GCJ坐标输入框
  var coordStr = state.sharedGcjLng.toFixed(6) + 'E, ' + state.sharedGcjLat.toFixed(6) + 'N'
  document.getElementById('coordsText').value = coordStr

  // 逆地理编码获取地址
  if (amapKey && state.sharedGcjLng && state.sharedGcjLat) {
    log('[加载照片信息] 正在逆地理编码...')
    try {
      var address = await reverseGeocode(state.sharedGcjLng, state.sharedGcjLat, amapKey)
      state.sharedAddress = address
      document.getElementById('addressText').value = address
      log('[加载照片信息] 地址: ' + address, 'ok')
    } catch (e) {
      log('[加载照片信息] 逆地理编码失败: ' + e.message, 'warn')
    }
  }

  // 自动填充拍摄日期
  if (!document.getElementById('dateText').value.trim()) {
    var autoDate = exifResult && exifResult.date
      ? formatExifDate(exifResult.date)
      : formatDate(new Date(file.lastModified))
    document.getElementById('dateText').value = autoDate
  }

  // 加载静态地图
  state.sharedMapImg = null
  if (document.getElementById('showMap').checked && amapKey && state.sharedGcjLng && state.sharedGcjLat) {
    log('[加载照片信息] 正在加载静态地图...')
    try {
      var cacheKey = state.sharedGcjLng.toFixed(4) + ',' + state.sharedGcjLat.toFixed(4)
      if (state.mapCache.has(cacheKey)) {
        state.sharedMapImg = state.mapCache.get(cacheKey)
        log('[加载照片信息] 地图: 使用缓存', 'ok')
        if (typeof WMEvent === 'function') WMEvent('map:loaded', { fromCache: true, w: state.sharedMapImg.naturalWidth, h: state.sharedMapImg.naturalHeight })
      } else {
        state.sharedMapImg = await Watermark.loadMapImage(state.sharedGcjLng, state.sharedGcjLat, amapKey, 350, parseInt(document.getElementById('mapZoom').value) || 15)
        if (state.sharedMapImg) {
          state.mapCache.set(cacheKey, state.sharedMapImg)
          log('[加载照片信息] 地图: 加载成功 ' + state.sharedMapImg.naturalWidth + 'x' + state.sharedMapImg.naturalHeight, 'ok')
          if (typeof WMEvent === 'function') WMEvent('map:loaded', { fromCache: false, w: state.sharedMapImg.naturalWidth, h: state.sharedMapImg.naturalHeight })
        } else {
          log('[加载照片信息] 地图: 加载失败', 'warn')
          if (typeof WMEvent === 'function') WMEvent('map:failed', { fromCache: false })
        }
      }
    } catch (e) {
      log('[加载照片信息] 地图加载失败: ' + e.message, 'warn')
    }
  }

  // 更新地图预览
  updateMapPreview()

  // 退出选择模式
  state.selectMode = false
  updateUI()

  showToast('照片信息已加载，请确认水印配置')
}

// ===== 更新地图预览 =====
function updateMapPreview() {
  var previewDiv = document.getElementById('mapPreview')
  var previewImg = document.getElementById('mapPreviewImg')
  if (!previewDiv || !previewImg) return

  if (state.sharedMapImg) {
    // 地图图像为 CORS 干净（crossOrigin='anonymous' 加载），可直接显示/绘入 canvas
    previewImg.src = state.sharedMapImg.src || state.sharedMapImg._apiUrl
    previewDiv.style.display = ''
  } else {
    previewDiv.style.display = 'none'
  }
}


async function getCurrentLocation() {
  var info = document.getElementById('locationInfo')
  info.textContent = '⏳ 获取中...'

  try {
    var pos = await new Promise(function(resolve, reject) {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, timeout: 15000, maximumAge: 0
      })
    })

    var wgsLng = pos.coords.longitude
    var wgsLat = pos.coords.latitude
    var gcj = CoordTransform.wgs84ToGcj02(wgsLng, wgsLat)

    state.currentLocation = {
      wgsLng: wgsLng, wgsLat: wgsLat,
      lng: gcj.lng, lat: gcj.lat,
      address: ''
    }

    info.innerHTML = '✅ GCJ02: ' + gcj.lng.toFixed(6) + ', ' + gcj.lat.toFixed(6) + '<br>WGS84: ' + wgsLng.toFixed(6) + ', ' + wgsLat.toFixed(6)

    var amapKey = AMAP_WEB_KEY
    if (amapKey) {
      try {
        var addr = await reverseGeocode(gcj.lng, gcj.lat, amapKey)
        state.currentLocation.address = addr
        info.innerHTML += '<br>📍 ' + addr
        document.getElementById('addressText').value = addr
      } catch (e) {
        log('[定位] 逆地理编码失败: ' + e.message, 'warn')
      }
    }

    showToast('定位成功')
    log('[定位] 成功 GCJ02(' + gcj.lng.toFixed(6) + ',' + gcj.lat.toFixed(6) + ')', 'ok')
  } catch (e) {
    info.innerHTML = '❌ 定位失败: ' + e.message
    showToast('定位失败，请检查浏览器定位权限')
    log('[定位] 失败: ' + e.message, 'err')
  }
}

// ===== 逆地理编码（JSONP 绕过 CORS）=====
function reverseGeocode(lng, lat, amapKey) {
  return new Promise(function(resolve, reject) {
    if (!amapKey) { reject(new Error('无高德Key')); return }

    var callbackName = '_amap_regeo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)

    var script = document.createElement('script')
    script.src = 'https://restapi.amap.com/v3/geocode/regeo?key=' + amapKey + '&location=' + lng + ',' + lat + '&extensions=base&callback=' + callbackName
    log('[高德] 逆地理编码请求: ' + script.src, 'info')

    var timer = setTimeout(function() {
      delete window[callbackName]
      if (script.parentNode) script.parentNode.removeChild(script)
      log('[高德] 逆地理编码超时', 'err')
      reject(new Error('逆地理编码超时'))
    }, 10000)

    window[callbackName] = function(data) {
      clearTimeout(timer)
      delete window[callbackName]
      if (script.parentNode) script.parentNode.removeChild(script)
      if (data && data.status === '1' && data.regeocode) {
        log('[高德] 逆地理编码成功 (status=1)', 'ok')
        resolve(data.regeocode.formatted_address || '')
      } else {
        log('[高德] 逆地理编码失败: ' + ((data && data.info) || '未知错误'), 'err')
        reject(new Error((data && data.info) || '逆地理编码失败'))
      }
    }

    script.onerror = function() {
      clearTimeout(timer)
      delete window[callbackName]
      if (script.parentNode) script.parentNode.removeChild(script)
      log('[高德] 逆地理编码网络错误', 'err')
      reject(new Error('逆地理编码网络错误'))
    }

    document.head.appendChild(script)
  })
}

// ===== 批量处理（使用统一水印） =====
async function startBatchProcess() {
  if (state.files.length === 0) return
  if (state.processing) return

  state.processing = true
  state.processed.clear()
  state.startTime = Date.now()

  var progressArea = document.getElementById('progressArea')
  var progressFill = document.getElementById('progressFill')
  var progressPercent = document.getElementById('progressPercent')
  var progressText = document.getElementById('progressText')
  var processBtn = document.getElementById('processBtn')
  var logCard = document.getElementById('logCard')
  var logArea = document.getElementById('logArea')

  progressArea.style.display = ''
  logCard.style.display = ''
  // 处理时自动展开日志
  var logBody = document.getElementById('logBody')
  if (logBody) logBody.style.display = ''
  var logToggleTxt = document.querySelector('#logCard .log-toggle-text')
  if (logToggleTxt) logToggleTxt.textContent = '收起 ▲'
  logArea.innerHTML = ''
  processBtn.disabled = true

  var config = getConfig()
  validateBeforeProcess(config)   // 预检：地图/Key/坐标
  var total = state.files.length
  var done = 0

  // 使用统一水印数据
  var useSharedGps = (state.sharedGcjLng != null && state.sharedGcjLat != null)
  var address = config.address || state.sharedAddress || ''
  var mapImg = state.sharedMapImg

  log('🚀 开始批量处理，共 ' + total + ' 张照片', 'ok')
  if (typeof WMEvent === 'function') WMEvent('process:start', { total: total, useSharedGps: useSharedGps, hasMap: !!(config.showMap && mapImg) })
  log('  统一水印模式: ' + (useSharedGps ? 'GCJ02(' + state.sharedGcjLng.toFixed(6) + ',' + state.sharedGcjLat.toFixed(6) + ')' : '无GPS'), useSharedGps ? 'ok' : 'warn')
  log('  配置: 项目=' + (config.showProject ? config.projectName || '(空)' : '关') +
      ' | 地址=' + (config.showAddress ? address || '(空)' : '关') +
      ' | 坐标=' + (config.showCoords ? '开' : '关') +
      ' | 备注=' + (config.showRemark ? config.remark || '(空)' : '关') +
      ' | 日期=' + (config.showDate ? '开' : '关') +
      ' | 地图=' + (config.showMap ? (mapImg ? '已加载' : '未加载') : '关'), 'ok')

  for (var idx = 0; idx < state.files.length; idx++) {
    var file = state.files[idx]
    var key = file.name + '_' + file.size
    var fileStart = Date.now()
    // 启动该照片的高精度性能计时（各阶段见 watermark-chunked.js / EXIF 注入）
    if (typeof WMPerf !== 'undefined') WMPerf.start(key)
    try {
      log('[' + (idx + 1) + '/' + total + '] ' + file.name + ' (' + Math.round(file.size / 1024) + 'KB)')

      var exifResult = state.exifData.get(key)
      var orientation = exifResult && exifResult.orientation ? exifResult.orientation : 1

      // 照片级调试记录：开局即写入原图与坐标信息
      var _gpsWgs = (exifResult && exifResult.gps) ? { lat: +exifResult.gps.lat.toFixed(6), lng: +exifResult.gps.lng.toFixed(6) } : null
      var _gpsGcj = (exifResult && exifResult.gps) ? (function () { try { var g = CoordTransform.wgs84ToGcj02(exifResult.gps.lng, exifResult.gps.lat); return { lat: +g.lat.toFixed(6), lng: +g.lng.toFixed(6) } } catch (e) { return null } })() : null
      if (typeof WMPhoto === 'function') {
        WMPhoto(key, {
          fileName: file.name, originalSizeKB: Math.round(file.size / 1024), type: file.type,
          hasGps: !!_gpsWgs, gpsWgs84: _gpsWgs, gpsGcj02: _gpsGcj,
          exifDate: exifResult ? exifResult.date : null, orientation: orientation, startTime: fileStart
        })
      }
      if (typeof WMEvent === 'function') WMEvent('photo:start', { fileName: file.name, key: key, idx: idx })

      // 日期：手动输入优先，否则从EXIF获取
      var autoDate = exifResult && exifResult.date
        ? formatExifDate(exifResult.date)
        : formatDate(new Date(file.lastModified))
      if (idx === 0 && !document.getElementById('dateText').value.trim()) {
        document.getElementById('dateText').value = autoDate
      }
      var dateStr = config.dateText || autoDate

      // 坐标字符串
      var coordStr = config.coordsText || ''

      var wmConfig = {
        projectName: config.showProject ? config.projectName : '',
        address: config.showAddress ? address : '',
        remark: config.showRemark ? config.remark : '',
        dateStr: config.showDate ? dateStr : '',
        coordStr: config.showCoords ? coordStr : '',
        showProject: config.showProject,
        showAddress: config.showAddress,
        showCoords: config.showCoords,
        showRemark: config.showRemark,
        showDate: config.showDate,
        showMap: config.showMap,
        mapImg: mapImg,
        orientation: orientation
      }

      // ===== 分块方案优先（低内存），传统Canvas方案降级 =====
      // 分块方案：只画800px信息栏Canvas + jpeg-js像素操作，无需整张图进Canvas
      // 传统方案：整张图+信息栏进Canvas，大图容易超Canvas内存限制

      var watermarkedBlob = null
      var usedChunked = false

      // 方案1: 分块方案（优先，低内存）
      if (typeof WatermarkChunked !== 'undefined' && typeof jpeg !== 'undefined') {
        try {
          var arrayBuffer = await file.arrayBuffer()
          if (typeof WMPerf !== 'undefined') WMPerf.stage(key, 'read-arrayBuffer', { bytes: arrayBuffer.byteLength })
          watermarkedBlob = await WatermarkChunked.addWatermarkChunked(arrayBuffer, wmConfig, null, key)
          arrayBuffer = null  // 释放原始字节
          if (watermarkedBlob) {
            usedChunked = true
            log('  ├─ 分块方案成功（零画质损失）', 'ok')
            if (typeof WMPhoto === 'function') WMPhoto(key, { usedChunked: true, fallback: false })
          }
        } catch (chunkErr) {
          log('  ⚠️ 分块方案失败: ' + chunkErr.message + '，尝试Canvas方案', 'warn')
          if (typeof WMEvent === 'function') WMEvent('photo:chunked-failed', { key: key, error: chunkErr.message })
          watermarkedBlob = null
        }
      }

      // 方案2: 分块方案强制缩放降级（仍走原生 Canvas toBlob，避免文件暴涨/画质有损）
      // 仅在方案1返回 null/抛错时触发（极少数超大/异常图片）
      if (!watermarkedBlob) {
        try {
          var fbBuf = await file.arrayBuffer()
          if (typeof WMPerf !== 'undefined') WMPerf.stage(key, 'read-arrayBuffer-fb', { bytes: fbBuf.byteLength })
          var fallbackScales = [0.6, 0.4, 0.25, 0.12]
          var fbOk = false
          for (var fi = 0; fi < fallbackScales.length; fi++) {
            log('  ⚠️ 原尺寸处理失败，尝试缩放至 ' + Math.round(fallbackScales[fi] * 100) + '% 重试...', 'warn')
            if (typeof WMPhotoStep === 'function') WMPhotoStep(key, 'fallback-forceScale', { scale: fallbackScales[fi] })
            try {
              var fbBlob = await WatermarkChunked.addWatermarkChunked(fbBuf, wmConfig, fallbackScales[fi], key)
              if (fbBlob && fbBlob.size >= 100) {
                watermarkedBlob = fbBlob
                fbOk = true
                log('  ✅ 缩放 ' + Math.round(fallbackScales[fi] * 100) + '% 成功，输出 ' + Math.round(fbBlob.size / 1024) + 'KB', 'ok')
                break
              }
            } catch (fbErr) {
              log('  ⚠️ 缩放 ' + Math.round(fallbackScales[fi] * 100) + '% 失败: ' + fbErr.message, 'warn')
            }
          }
          fbBuf = null
          if (!fbOk) {
            throw new Error('分块方案和缩放降级均失败（内存不足）')
          }
          if (typeof WMPhoto === 'function') WMPhoto(key, { usedChunked: true, fallback: true })
        } catch (fbReadErr) {
          throw new Error('降级重试失败: ' + fbReadErr.message)
        }
      }

      // ===== EXIF 注入 =====
      // piexif 只接受 dataURL，需要临时将 Blob 转为 dataURL
      // 处理完立即释放 dataURL 引用，避免占用 JS 堆
      var exifObj = exifResult && exifResult.exifObj ? exifResult.exifObj : null
      var needExif = (useSharedGps || (exifObj && orientation !== 1))

      // 大图保护：单张输出超过阈值时跳过 EXIF 重编码
      // 避免 Blob→dataURL（base64）生成数十 MB 字符串导致卡顿/内存溢出
      // 此时 GPS 坐标已显示在水印栏中，不影响查看
      if (needExif && watermarkedBlob.size > 16 * 1024 * 1024) {
        log('  ├─ 大图(>16MB)跳过EXIF重编码，避免卡顿/内存溢出（GPS已显示在水印栏）', 'warn')
        if (typeof WMPhoto === 'function') WMPhoto(key, { exifSkippedLarge: true, exifInjected: false })
        needExif = false
      } else if (needExif) {
        if (typeof WMPhoto === 'function') WMPhoto(key, { exifInjected: true, exifSource: useSharedGps ? 'sharedGps' : 'orientation' })
      }

      var resultBlob = watermarkedBlob

      if (needExif) {
        // Blob → dataURL（临时，仅用于 piexif）
        // ⚠️ 此步是 base64 编码超大 Blob，CPU 密集，是大图卡顿/发热主因之一
        var tempDataUrl = await blobToDataUrl(watermarkedBlob)
        watermarkedBlob = null  // 释放 Blob 引用
        if (typeof WMPerf !== 'undefined') WMPerf.stage(key, 'exif-blobToDataUrl', { inBytes: tempDataUrl ? tempDataUrl.length : 0 })

        var finalDataUrl = tempDataUrl

        if (useSharedGps) {
          exifObj = ExifUtils.injectGps(exifObj, state.sharedWgsLng, state.sharedWgsLat)
          finalDataUrl = ExifUtils.insertExif(tempDataUrl, exifObj)
        } else if (exifObj && orientation !== 1) {
          var orientTag = (piexif.ImageIFD && piexif.ImageIFD.Orientation) || 274
          if (!exifObj['0th']) exifObj['0th'] = {}
          exifObj['0th'][orientTag] = 1
          finalDataUrl = ExifUtils.insertExif(tempDataUrl, exifObj)
        }
        tempDataUrl = null  // 释放原始 dataURL
        if (typeof WMPerf !== 'undefined') WMPerf.stage(key, 'exif-insert', { outBytes: finalDataUrl ? finalDataUrl.length : 0 })

        // 校验最终 dataURL 有效性（防止 insertExif 损坏数据）
        if (!finalDataUrl || finalDataUrl.length < 100 || finalDataUrl === 'data:,') {
          log('  ⚠️ EXIF插入后数据异常，使用原始水印数据', 'warn')
        } else {
          // dataURL → Blob 存储（base64 解码，同样 CPU 密集）
          resultBlob = dataUrlToBlob(finalDataUrl)
          if (typeof WMPerf !== 'undefined') WMPerf.stage(key, 'exif-dataUrlToBlob', { inBytes: finalDataUrl.length })
        }
        finalDataUrl = null  // 释放 dataURL 引用
      }

      // ===== 校验 resultBlob 有效性，防止存入 0KB 或 null =====
      if (!validateBlob(resultBlob, '水印结果')) {
        throw new Error('水印结果为无效Blob（大小=' + (resultBlob ? resultBlob.size : 'null') + 'B）')
      }

      var resultBlobUrl = URL.createObjectURL(resultBlob)
      state.processed.set(key, { blob: resultBlob, blobUrl: resultBlobUrl, name: file.name })

      var dur = Date.now() - fileStart
      log('  ✅ 完成 (' + dur + 'ms) 大小=' + Math.round(resultBlob.size / 1024) + 'KB', 'ok')
      if (typeof WMPhoto === 'function') WMPhoto(key, { outputSizeKB: Math.round(resultBlob.size / 1024), outputRatio: +(resultBlob.size / file.size * 100).toFixed(0), durationMs: dur, error: null, processed: true })
      if (typeof WMEvent === 'function') WMEvent('photo:success', { fileName: file.name, key: key, outputSizeKB: Math.round(resultBlob.size / 1024), durationMs: dur })

    } catch (e) {
      log('  ❌ 失败: ' + e.message, 'err')
      console.error('[处理失败] ' + file.name, e)
      if (typeof WMPhoto === 'function') WMPhoto(key, { error: e.message, durationMs: Date.now() - fileStart, processed: false })
      if (typeof WMEvent === 'function') WMEvent('photo:fail', { fileName: file.name, key: key, error: e.message })
    }

    // ===== 性能汇总：结束高精度计时，写入照片记录并实时打印各阶段耗时 =====
    var perf = (typeof WMPerf !== 'undefined') ? WMPerf.end(key) : null
    if (perf) {
      if (typeof WMPhoto === 'function') WMPhoto(key, { perf: perf, perfTotalMs: perf.totalMs, heapPeakMB: perf.heapPeakMB })
      // 实时打印：一眼看出是哪一段（解码/编码/EXIF base64）拖慢、发热
      var stageStr = perf.stages.map(function (s) { return s.name + '=' + s.ms + 'ms' }).join('  ')
      log('  ⏱ 总 ' + perf.totalMs + 'ms | ' + stageStr, 'info')
    }

    // 释放 canvas 内存，防止批量处理时内存累积
    var wmCanvas = document.getElementById('watermarkCanvas')
    if (wmCanvas) {
      var wmCtx = wmCanvas.getContext('2d')
      wmCtx.clearRect(0, 0, wmCanvas.width, wmCanvas.height)
      wmCanvas.width = 1
      wmCanvas.height = 1
    }

    // 短暂让出主线程，允许GC回收内存
    if (idx < state.files.length - 1) {
      await new Promise(function(r) { setTimeout(r, 80) })
    }

    done++
    var pct = Math.round(done / total * 100)
    progressFill.style.width = pct + '%'
    if (progressPercent) progressPercent.textContent = pct + '%'
    progressText.textContent = done + ' / ' + total + ' 已处理'
  }

  var totalCost = Date.now() - state.startTime
  log('---')
  log('全部完成！' + state.processed.size + '/' + total + ' 张成功，耗时 ' + (totalCost / 1000).toFixed(1) + 's', 'ok')
  if (typeof WMEvent === 'function') WMEvent('process:end', { success: state.processed.size, total: total, totalCostMs: totalCost })
  progressText.textContent = '完成！' + state.processed.size + '/' + total + ' 张'
  if (progressPercent) progressPercent.textContent = '100%'
  var pl = document.getElementById('perfLive')
  if (pl) pl.textContent = '处理完成，共 ' + totalCost / 1000 + 's'

  state.processing = false
  processBtn.disabled = false
  document.getElementById('downloadBtn').disabled = state.processed.size === 0
  document.getElementById('albumBtn').disabled = state.processed.size === 0

  updateUI()
  showToast('处理完成！' + state.processed.size + ' 张照片已加水印')
}

// ===== 批量处理前预检 =====
function validateBeforeProcess(config) {
  var warnings = []

  // 检查地图：若开启地图但地图未加载成功，警告但允许继续
  if (config.showMap) {
    if (!state.sharedMapImg) {
      warnings.push('⚠️ 已开启地图，但地图图片未加载成功，水印将显示"地图不可用"占位符。')
    }
  }

  // 检查高德Key：若需要逆地理编码但没有Key
  if (config.showAddress && !config.amapKey) {
    warnings.push('⚠️ 已开启地址显示，但未填写高德Key，地址将为空。')
  }

  // 检查坐标：统一模式但没有坐标
  if (config.showCoords && !config.coordsText) {
    warnings.push('⚠️ 已开启坐标显示，但未填写坐标，坐标将显示为空。')
  }

  if (warnings.length > 0) {
    log('---')
    warnings.forEach(function(w) { log(w, 'warn') })
  }
  return warnings
}

// ===== 生成压缩包 =====
async function downloadAll() {
  if (state.processed.size === 0) { showToast('请先添加照片并添加水印'); return }

  // 先校验所有已处理照片的 Blob 有效性
  var invalidKeys = []
  state.processed.forEach(function(obj, key) {
    if (!validateBlob(obj && obj.blob, '下载-' + key)) invalidKeys.push(key)
  })
  if (invalidKeys.length > 0) {
    showToast('存在 ' + invalidKeys.length + ' 张无效照片，请重新添加水印')
    log('[下载] 发现 ' + invalidKeys.length + ' 张无效照片，已阻止打包', 'err')
    return
  }

  var downloadBtn = document.getElementById('downloadBtn')
  downloadBtn.disabled = true
  downloadBtn.textContent = '⏳ 打包中...'

  try {
    var zip = new JSZip()
    var folder = zip.folder('watermarked')

    state.processed.forEach(function(obj, key) {
      if (!validateBlob(obj && obj.blob, '下载-' + key)) return
      var fileName = outputFileName(obj.name)
      folder.file(fileName, obj.blob, { binary: true })
    })

    log('[下载] 开始打包 ' + state.processed.size + ' 张照片...', 'ok')
    var blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })

    // 文件名：拍摄日期_项目名称_备注，空则跳过，全空则用当前日期时间
    var parts = []
    var shootingDate = document.getElementById('dateText').value.trim().replace(/-/g, '')
    var projName = document.getElementById('projectName').value.trim()
    var remarkVal = document.getElementById('remarkText').value.trim()
    if (shootingDate) parts.push(shootingDate)
    if (projName) parts.push(projName)
    if (remarkVal) parts.push(remarkVal)
    var zipName = parts.length > 0 ? parts.join('_') : formatDateCompact(new Date())
    saveAs(blob, zipName + '.zip')

    log('[下载] 打包完成，开始下载', 'ok')
    showToast('下载成功！')
  } catch (e) {
    log('[下载] 失败: ' + e.message, 'err')
    showToast('下载失败: ' + e.message)
  }

  downloadBtn.disabled = false
  downloadBtn.textContent = '生成压缩包'
}

// ===== 清空 =====
function clearAll() {
  if (state.files.length > 0 && !confirm('确定清空所有照片？')) return

  log('[清空] 清除 ' + state.files.length + ' 张照片及所有缓存', 'ok')

  // 释放所有 Blob URL
  state.processed.forEach(function(obj) {
    if (obj && obj.blobUrl) URL.revokeObjectURL(obj.blobUrl)
  })

  state.files = []
  state.exifData.clear()
  state.processed.clear()
  state.mapCache.clear()
  state.sharedMapImg = null
  state.sharedWgsLng = state.sharedWgsLat = null
  state.sharedGcjLng = state.sharedGcjLat = null
  state.sharedAddress = null
  state.selectMode = false
  state.selectedIdx = -1

  // 清除地图预览
  var mapPreview = document.getElementById('mapPreview')
  if (mapPreview) mapPreview.style.display = 'none'

  document.getElementById('progressArea').style.display = 'none'

  updateUI()
}

// ===== 保存到相册 =====
async function saveToAlbum() {
  if (state.processed.size === 0) return

  var albumBtn = document.getElementById('albumBtn')
  albumBtn.disabled = true
  albumBtn.textContent = '保存中...'

  try {
    // 先校验所有 Blob 有效性
    var invalidKeys = []
    state.processed.forEach(function(obj, key) {
      if (!validateBlob(obj && obj.blob, '相册-' + key)) invalidKeys.push(key)
    })
    if (invalidKeys.length > 0) {
      showToast('存在 ' + invalidKeys.length + ' 张无效照片，请重新添加水印')
      log('[相册] 发现 ' + invalidKeys.length + ' 张无效照片，已阻止保存', 'err')
      albumBtn.disabled = false
      albumBtn.textContent = '保存到相册'
      return
    }

    // 优先使用 Web Share API（iOS Safari 原生分享表单，可保存到相册）
    if (navigator.share && navigator.canShare) {
      var files = []
      state.processed.forEach(function(obj, key) {
        if (!obj || !obj.blob) return
        var fileName = outputFileName(obj.name)
        files.push(new File([obj.blob], fileName, { type: 'image/jpeg' }))
      })

      var shareData = { files: files }
      if (navigator.canShare(shareData)) {
        await navigator.share(shareData)
        log('[相册] 已通过分享保存', 'ok')
        showToast('已保存到相册')
        albumBtn.disabled = false
        albumBtn.textContent = '保存到相册'
        return
      }
    }

    // 降级方案：逐张下载（间隔500ms防止浏览器拦截）
    log('[相册] 浏览器不支持直接保存到相册，将逐张下载', 'warn')
    var entries = []
    state.processed.forEach(function(obj, key) {
      if (!obj || !obj.blobUrl) return
      entries.push({ blobUrl: obj.blobUrl, fileName: outputFileName(obj.name) })
    })
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      var a = document.createElement('a')
      a.href = entry.blobUrl
      a.download = entry.fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      if (i < entries.length - 1) {
        await new Promise(function(r) { setTimeout(r, 500) })
      }
    }
    log('[相册] 已下载 ' + entries.length + ' 张照片', 'ok')
    showToast('已下载 ' + entries.length + ' 张照片，请在下载目录查看')
  } catch (e) {
    if (e.name !== 'AbortError') {
      log('[相册] 保存失败: ' + e.message, 'err')
      showToast('保存失败: ' + e.message)
    }
  }

  albumBtn.disabled = false
  albumBtn.textContent = '保存到相册'
}

// ===== 导出调试信息（结构化全记录）=====
// 生成 schemaVersion + environment + summary + photos(含步骤时间线) + events + logs(含t/level/source)
function buildDebugInfo() {
  var config = getConfig()
  var now = new Date()
  if (typeof captureEnvironment === 'function') captureEnvironment()  // 导出时刷新环境快照
  var d = window.WMDebug || {}
  var env = d.env || {}

  // photos: 合并 WMDebug.photos（处理埋点）与 state（原始/处理结果）
  var photos = state.files.map(function (f) {
    var key = f.name + '_' + f.size
    var rec = (d.photos && d.photos[key]) ? JSON.parse(JSON.stringify(d.photos[key])) : { key: key }
    var exif = state.exifData.get(key)
    rec.fileName = rec.fileName || f.name
    rec.originalSizeKB = rec.originalSizeKB != null ? rec.originalSizeKB : Math.round(f.size / 1024)
    rec.type = rec.type || f.type
    rec.hasGps = rec.hasGps != null ? rec.hasGps : !!(exif && exif.gps)
    if (rec.gpsWgs84 == null && exif && exif.gps) rec.gpsWgs84 = { lat: +exif.gps.lat.toFixed(6), lng: +exif.gps.lng.toFixed(6) }
    if (rec.exifDate == null && exif) rec.exifDate = exif.date
    rec.processed = state.processed.has(key)
    if (rec.path == null) rec.path = rec.processed ? 'unknown' : 'not-processed'
    if (rec.steps == null) rec.steps = []
    return rec
  })

  var totalOrig = 0, totalOut = 0, failed = 0, gps = 0
  photos.forEach(function (p) {
    if (p.originalSizeKB) totalOrig += p.originalSizeKB
    if (p.outputSizeKB) totalOut += p.outputSizeKB
    if (p.error) failed++
    if (p.hasGps) gps++
  })

  // 性能聚合：跨所有照片汇总各阶段耗时与数据量，定位卡顿/发热主因
  var stageAgg = {}
  var heapPeakAll = null
  var perfPhotoCount = 0
  photos.forEach(function (p) {
    if (!p.perf || !p.perf.stages) return
    perfPhotoCount++
    if (p.perf.heapPeakMB != null) {
      if (heapPeakAll == null || p.perf.heapPeakMB > heapPeakAll) heapPeakAll = p.perf.heapPeakMB
    }
    p.perf.stages.forEach(function (s) {
      var a = stageAgg[s.name] || (stageAgg[s.name] = { name: s.name, totalMs: 0, count: 0, bytesIn: 0, bytesOut: 0 })
      a.totalMs += s.ms
      a.count += 1
      if (s.bytesIn) a.bytesIn += s.bytesIn
      if (s.bytes || s.outBytes) a.bytesOut += (s.bytes || s.outBytes)
    })
  })
  var stageList = Object.keys(stageAgg).map(function (k) {
    var a = stageAgg[k]
    a.avgMs = +(a.totalMs / a.count).toFixed(1)
    return a
  }).sort(function (a, b) { return b.totalMs - a.totalMs })
  var dominant = stageList.length ? stageList[0] : null
  // 已知的高 CPU 发热/卡顿阶段（编码与 base64 转换）
  var HOT = ['decode', 'composite', 'toBlob', 'exif-blobToDataUrl', 'exif-insert', 'exif-dataUrlToBlob', '[jpegjs]encode', '[jpegjs]pixelMerge']
  var hotStages = HOT.filter(function (n) { return stageAgg[n] })
  // 数据量换算（MB）
  stageList.forEach(function (a) {
    if (a.bytesIn) a.bytesInMB = +(a.bytesIn / 1048576).toFixed(1)
    if (a.bytesOut) a.bytesOutMB = +(a.bytesOut / 1048576).toFixed(1)
  })
  var perfSummary = {
    photosWithPerf: perfPhotoCount,
    totalPhotos: photos.length,
    dominantStage: dominant ? { name: dominant.name, totalMs: Math.round(dominant.totalMs), avgMs: dominant.avgMs, count: dominant.count } : null,
    heapPeakMB: heapPeakAll,
    hotStages: hotStages,
    stages: stageList
  }

  return {
    schemaVersion: d.schemaVersion || 3,
    appVersion: d.appVersion || APP_VERSION,
    exportTime: now.toISOString(),
    url: location.href,
    environment: env,
    limits: d.limits || null,
    config: config,
    summary: {
      totalFiles: state.files.length,
      processed: state.processed.size,
      failed: failed,
      gpsFiles: gps,
      noGpsFiles: state.files.length - gps,
      totalOriginalKB: totalOrig,
      totalOutputKB: totalOut,
      avgOutputRatioPct: totalOrig ? Math.round(totalOut / totalOrig * 100) : null
    },
    perfSummary: perfSummary,
    location: {
      hasLocation: !!state.currentLocation,
      locationGcj02: state.currentLocation ? { lng: +state.currentLocation.lng.toFixed(6), lat: +state.currentLocation.lat.toFixed(6) } : null
    },
    photos: photos,
    events: d.events || [],
    logs: (d.entries || []).map(function (e) {
      return { t: new Date(e.t).toISOString(), ts: e.t, level: e.level, source: e.source, msg: e.msg }
    })
  }
}

function exportDebugInfo() {
  var debugInfo = buildDebugInfo()
  var jsonStr = JSON.stringify(debugInfo, null, 2)
  var blob = new Blob([jsonStr], { type: 'application/json' })
  var url = URL.createObjectURL(blob)
  var a = document.createElement('a')
  a.href = url
  a.download = 'watermark-debug-' + formatDateCompact(new Date()) + '.json'
  document.body.appendChild(a)
  a.click()
  setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url) }, 100)
  showToast('调试信息已导出 (' + debugInfo.photos.length + ' 张照片, ' + debugInfo.logs.length + ' 条日志)')
  log('[导出] 调试信息已导出: ' + debugInfo.photos.length + ' 张照片, ' + debugInfo.logs.length + ' 条日志', 'ok')
}

function copyDebugInfo() {
  try {
    var debugInfo = buildDebugInfo()
    var jsonStr = JSON.stringify(debugInfo, null, 2)
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(jsonStr).then(function () {
        showToast('调试信息已复制到剪贴板')
        log('[导出] 调试信息已复制到剪贴板 (' + debugInfo.logs.length + ' 条日志)', 'ok')
      }, function (err) {
        showToast('复制失败，请改用「导出」下载文件')
        log('[导出] 复制到剪贴板失败: ' + (err && err.message), 'warn')
      })
    } else {
      showToast('当前环境不支持复制，请改用「导出」')
    }
  } catch (e) {
    showToast('复制失败: ' + e.message)
    log('[导出] 复制失败: ' + e.message, 'err')
  }
}

// ===== 配置 =====
function getConfig() {
  return {
    projectName: document.getElementById('projectName').value.trim(),
    address: document.getElementById('addressText').value.trim(),
    remark: document.getElementById('remarkText').value.trim(),
    amapKey: AMAP_WEB_KEY,
    showProject: document.getElementById('showProject').checked,
    showAddress: document.getElementById('showAddress').checked,
    showCoords: document.getElementById('showCoords').checked,
    showRemark: document.getElementById('showRemark').checked,
    showDate: document.getElementById('showDate').checked,
    showMap: document.getElementById('showMap').checked,
    mapZoom: parseInt(document.getElementById('mapZoom').value) || 15,
    coordsText: document.getElementById('coordsText').value.trim(),
    dateText: document.getElementById('dateText').value.trim(),
  }
}

function saveConfig() {
  var config = getConfig()
  localStorage.setItem('watermarkConfig', JSON.stringify(config))
}

function loadSavedConfig() {
  try {
    var saved = JSON.parse(localStorage.getItem('watermarkConfig'))
    if (!saved) return
    if (saved.projectName) document.getElementById('projectName').value = saved.projectName
    // 地址和坐标不恢复，避免前一次数据污染本次
    if (saved.remark) document.getElementById('remarkText').value = saved.remark
    if (saved.showProject !== undefined) document.getElementById('showProject').checked = saved.showProject
    if (saved.showAddress !== undefined) document.getElementById('showAddress').checked = saved.showAddress
    if (saved.showCoords !== undefined) document.getElementById('showCoords').checked = saved.showCoords
    if (saved.showRemark !== undefined) document.getElementById('showRemark').checked = saved.showRemark
    if (saved.showDate !== undefined) document.getElementById('showDate').checked = saved.showDate
    if (saved.showMap !== undefined) document.getElementById('showMap').checked = saved.showMap
    if (saved.mapZoom !== undefined) {
      document.getElementById('mapZoom').value = saved.mapZoom
      var zoomValueEl = document.getElementById('mapZoomValue')
      if (zoomValueEl) zoomValueEl.textContent = saved.mapZoom
    }
    // coordsText 不恢复
    // dateText 不恢复
  } catch (e) {}
}

// ===== Blob 有效性校验 =====
function validateBlob(blob, label) {
  if (!blob || !(blob instanceof Blob)) {
    log('  ❌ ' + (label || 'Blob') + ': 不是有效Blob', 'err')
    return false
  }
  if (blob.size === 0) {
    log('  ❌ ' + (label || 'Blob') + ': 大小为0', 'err')
    return false
  }
  if (blob.size < 100) {
    log('  ❌ ' + (label || 'Blob') + ': 大小异常(' + blob.size + 'B)', 'err')
    return false
  }
  return true
}

// ===== 工具函数 =====

// 输出文件名：剥离原始扩展名后统一加 .jpg（输出恒为 JPEG 重编码）
// 例：photo.jpeg → photo.jpg，IMG_1234.jpg → IMG_1234.jpg
function outputFileName(origName) {
  var name = origName || 'photo'
  var dot = name.lastIndexOf('.')
  var base = (dot > 0 && dot > name.lastIndexOf('/') && dot > name.lastIndexOf('\\')) ? name.slice(0, dot) : name
  return base + '.jpg'
}

function formatExifDate(exifDate) {
  if (!exifDate) return ''
  // EXIF格式 "2024:01:15 10:30:00" → "2024-01-15"（仅日期）
  return exifDate.replace(/^(\d{4}):(\d{2}):(\d{2}).*/, '$1-$2-$3')
}

function formatDate(date) {
  var y = date.getFullYear()
  var m = String(date.getMonth() + 1).padStart(2, '0')
  var d = String(date.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + d
}

function formatDateCompact(date) {
  var y = date.getFullYear()
  var m = String(date.getMonth() + 1).padStart(2, '0')
  var d = String(date.getDate()).padStart(2, '0')
  var h = String(date.getHours()).padStart(2, '0')
  var min = String(date.getMinutes()).padStart(2, '0')
  return y + m + d + '_' + h + min
}

function log(msg, level) {
  // 同步写入结构化调试记录（带来源 'ui'），供导出 JSON 使用
  if (typeof WMLog === 'function') WMLog(level || 'info', msg, 'ui')
  var logArea = document.getElementById('logArea')
  if (!logArea) return
  var cls = level === 'ok' ? 'log-ok' : level === 'warn' ? 'log-warn' : level === 'err' ? 'log-err' : ''
  var line = document.createElement('div')
  line.className = cls
  line.textContent = msg
  logArea.appendChild(line)
  logArea.scrollTop = logArea.scrollHeight
}

// 探测运行环境能力（写入调试记录，排障时一目了然）
function captureEnvironment() {
  var env = {}
  function safe(name, fn) { try { env[name] = fn() } catch (e) { env[name] = 'ERR:' + e.message } }

  safe('userAgent', function () { return navigator.userAgent })
  safe('platform', function () { return navigator.platform })
  safe('language', function () { return navigator.language })
  safe('languages', function () { return (navigator.languages || []).join(',') })
  safe('vendor', function () { return navigator.vendor })
  safe('deviceMemoryGB', function () { return navigator.deviceMemory })
  safe('hardwareConcurrency', function () { return navigator.hardwareConcurrency })
  safe('maxTouchPoints', function () { return navigator.maxTouchPoints })
  safe('onLine', function () { return navigator.onLine })
  safe('cookieEnabled', function () { return navigator.cookieEnabled })

  safe('screen', function () {
    return { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, colorDepth: screen.colorDepth, dpr: window.devicePixelRatio }
  })
  safe('window', function () { return { w: window.innerWidth, h: window.innerHeight } })
  safe('theme', function () { return document.documentElement.classList.contains('dark') ? 'dark' : 'light' })
  safe('timezone', function () { return Intl.DateTimeFormat().resolvedOptions().timeZone })
  safe('now', function () { return new Date().toISOString() })

  safe('features', function () {
    return {
      createImageBitmap: typeof createImageBitmap,
      OffscreenCanvas: typeof OffscreenCanvas,
      canvasToBlob: typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.toBlob,
      canvasToDataURL: typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.toDataURL,
      Worker: typeof Worker,
      fetch: typeof fetch,
      Blob: typeof Blob,
      createImageBitmapResize: (typeof createImageBitmap === 'function')
    }
  })

  // Canvas 上限探测：逐级尝试创建超大 Canvas（理论值）
  safe('canvasProbe', function () {
    var out = { theoreticalMaxSide: 16383 }
    var c = document.createElement('canvas')
    var sides = [16383, 12000, 8192, 4096]
    for (var i = 0; i < sides.length; i++) {
      try { c.width = sides[i]; c.height = 1; if (c.width === sides[i]) { out.maxSideOk = sides[i]; break } } catch (e) {}
    }
    return out
  })

  safe('perfMemory', function () {
    if (typeof performance !== 'undefined' && performance.memory) {
      return {
        usedJSHeapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
        totalJSHeapMB: Math.round(performance.memory.totalJSHeapSize / 1048576),
        jsHeapLimitMB: Math.round(performance.memory.jsHeapSizeLimit / 1048576)
      }
    }
    return null
  })

  // 高德 Key 仅保留后 4 位，便于确认是否配置而不泄露
  safe('amapKeyMasked', function () {
    var k = AMAP_WEB_KEY || ''
    return k.length > 4 ? '***' + k.slice(-4) : (k ? '***' : '(空)')
  })
  safe('storageLocal', function () { return typeof localStorage !== 'undefined' })

  if (window.WMDebug) {
    window.WMDebug.env = env
    window.WMDebug.appVersion = APP_VERSION
    window.WMDebug.url = location.href
  }
  return env
}

function showToast(msg) {  var toast = document.getElementById('toast')
  if (!toast) {
    toast = document.createElement('div')
    toast.id = 'toast'
    toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:10px 24px;background:#1f2937;color:#fff;border-radius:8px;font-size:14px;z-index:9999;opacity:0;transition:opacity 0.3s;pointer-events:none;'
    document.body.appendChild(toast)
  }
  toast.textContent = msg
  toast.style.opacity = '1'
  clearTimeout(toast._timer)
  toast._timer = setTimeout(function() { toast.style.opacity = '0' }, 2500)
}

// 自动保存配置
document.querySelectorAll('#projectName,#addressText,#remarkText,#coordsText,#dateText').forEach(function(el) {
  el.addEventListener('input', saveConfig)
})
// zoom滑动条：拖动中只更新数值，松开后才重新加载地图
document.getElementById('mapZoom').addEventListener('input', function() {
  document.getElementById('mapZoomValue').textContent = this.value
  saveConfig()
})
document.getElementById('mapZoom').addEventListener('change', function() {
  reloadMapOnZoomChange()
})

async function reloadMapOnZoomChange() {
  var amapKey = AMAP_WEB_KEY
  if (!document.getElementById('showMap').checked || !amapKey || !state.sharedGcjLng || !state.sharedGcjLat) return

  var zoom = parseInt(document.getElementById('mapZoom').value) || 15
  log('[地图] 缩放级别变更 → 重新加载地图 (zoom=' + zoom + ')')

  try {
    state.sharedMapImg = await Watermark.loadMapImage(state.sharedGcjLng, state.sharedGcjLat, amapKey, 350, zoom)
    if (state.sharedMapImg) {
      log('[地图] 重新加载成功', 'ok')
    } else {
      log('[地图] 重新加载失败', 'warn')
    }
  } catch (e) {
    log('[地图] 重新加载失败: ' + e.message, 'warn')
  }

  updateMapPreview()
}
document.querySelectorAll('input[type="checkbox"]').forEach(function(el) {
  el.addEventListener('change', saveConfig)
})
