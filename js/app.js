/**
 * app.js - 主应用逻辑
 * 浏览器端批量照片水印工具
 * 单列布局：照片列表(含选择按钮)→统计→配置→操作→日志
 */

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
  setupDragDrop()
  setupFileInputs()
  loadSavedConfig()
})

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
function setupFileInputs() {
  // 选择照片（手机上会弹出"拍照/相册"选项）
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
  var amapKey = document.getElementById('amapKey').value.trim()
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

  if (state.files.length === 0) {
    grid.innerHTML = ''
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
  var amapKey = document.getElementById('amapKey').value.trim()

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
      } else {
        state.sharedMapImg = await Watermark.loadMapImage(state.sharedGcjLng, state.sharedGcjLat, amapKey, 350, parseInt(document.getElementById('mapZoom').value) || 15)
        if (state.sharedMapImg) {
          state.mapCache.set(cacheKey, state.sharedMapImg)
          log('[加载照片信息] 地图: 加载成功 ' + state.sharedMapImg.naturalWidth + 'x' + state.sharedMapImg.naturalHeight, 'ok')
        } else {
          log('[加载照片信息] 地图: 加载失败', 'warn')
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
    if (state.sharedMapImg._fromProxy) {
      // 代理加载的同源图片，可安全使用canvas
      var canvas = document.createElement('canvas')
      canvas.width = state.sharedMapImg.naturalWidth || state.sharedMapImg.width
      canvas.height = state.sharedMapImg.naturalHeight || state.sharedMapImg.height
      var ctx = canvas.getContext('2d')
      ctx.drawImage(state.sharedMapImg, 0, 0)
      previewImg.src = canvas.toDataURL('image/png')
    } else if (state.sharedMapImg._apiUrl) {
      // 跨域直接加载，用原URL显示（Image可直接显示跨域图）
      previewImg.src = state.sharedMapImg._apiUrl
    } else {
      previewImg.src = state.sharedMapImg.src
    }
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

    var amapKey = document.getElementById('amapKey').value.trim()
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

    var timer = setTimeout(function() {
      delete window[callbackName]
      if (script.parentNode) script.parentNode.removeChild(script)
      reject(new Error('逆地理编码超时'))
    }, 10000)

    window[callbackName] = function(data) {
      clearTimeout(timer)
      delete window[callbackName]
      if (script.parentNode) script.parentNode.removeChild(script)
      if (data && data.status === '1' && data.regeocode) {
        resolve(data.regeocode.formatted_address || '')
      } else {
        reject(new Error((data && data.info) || '逆地理编码失败'))
      }
    }

    script.onerror = function() {
      clearTimeout(timer)
      delete window[callbackName]
      if (script.parentNode) script.parentNode.removeChild(script)
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
  var progressText = document.getElementById('progressText')
  var processBtn = document.getElementById('processBtn')
  var logCard = document.getElementById('logCard')
  var logArea = document.getElementById('logArea')

  progressArea.style.display = ''
  logCard.style.display = ''
  logArea.innerHTML = ''
  processBtn.disabled = true

  var config = getConfig()
  var total = state.files.length
  var done = 0

  // 使用统一水印数据
  var useSharedGps = (state.sharedGcjLng != null && state.sharedGcjLat != null)
  var address = config.address || state.sharedAddress || ''
  var mapImg = state.sharedMapImg

  log('🚀 开始批量处理，共 ' + total + ' 张照片', 'ok')
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
    try {
      log('[' + (idx + 1) + '/' + total + '] ' + file.name + ' (' + Math.round(file.size / 1024) + 'KB)')

      // 加载图片
      var imgInput
      var isBitmap = false
      try {
        var bitmap = await createImageBitmap(file)
        imgInput = bitmap
        isBitmap = true
      } catch (e) {
        imgInput = await ExifUtils.fileToImage(file)
      }

      var exifResult = state.exifData.get(key)
      var orientation = exifResult && exifResult.orientation ? exifResult.orientation : 1

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

      // ===== 原图优先，失败时渐进缩放重试 =====
      // addWatermark 现在返回 Blob（toBlob），不再返回 base64 字符串
      // 优势：Blob 由浏览器管理可交换磁盘，不占 JS 堆内存；base64 每张占 8-15MB
      var watermarkedBlob = await Watermark.addWatermark(imgInput, wmConfig)

      // 释放第一次的 ImageBitmap
      if (isBitmap && imgInput && typeof imgInput.close === 'function') {
        imgInput.close()
        imgInput = null
      }

      // 检查是否失败（toBlob 内存不足时返回 null 或极小 Blob）
      var failed = !watermarkedBlob || watermarkedBlob.size < 100

      if (failed) {
        // 渐进降级：先 4096，再 2048
        var retryDims = [4096, 2048]
        for (var ri = 0; ri < retryDims.length; ri++) {
          log('  ⚠️ 原尺寸处理失败(内存不足)，尝试缩小至 ' + retryDims[ri] + 'px 重试...', 'warn')

          // 重新加载图片
          try {
            var retryBitmap = await createImageBitmap(file)
            imgInput = scaleInput(retryBitmap, retryDims[ri])
          } catch (e3) {
            imgInput = await ExifUtils.fileToImage(file)
            imgInput = scaleInput(imgInput, retryDims[ri])
          }

          // 清理旧 canvas
          var wmCanvas = document.getElementById('watermarkCanvas')
          if (wmCanvas) { var wmCtx = wmCanvas.getContext('2d'); wmCtx.clearRect(0,0,wmCanvas.width,wmCanvas.height); wmCanvas.width=1; wmCanvas.height=1 }

          // GC间隔
          await new Promise(function(r) { setTimeout(r, 100) })

          watermarkedBlob = await Watermark.addWatermark(imgInput, wmConfig)

          // 释放重试用输入
          if (imgInput && typeof imgInput.close === 'function') imgInput.close()
          imgInput = null

          if (watermarkedBlob && watermarkedBlob.size >= 100) {
            log('  ✅ 缩放至 ' + retryDims[ri] + 'px 后成功（画质有损）', 'ok')
            failed = false
            break
          }
        }
      }

      if (failed) {
        throw new Error('原图及降级均处理失败（内存不足）')
      }

      // ===== EXIF 注入 =====
      // piexif 只接受 dataURL，需要临时将 Blob 转为 dataURL
      // 处理完立即释放 dataURL 引用，避免占用 JS 堆
      var exifObj = exifResult && exifResult.exifObj ? exifResult.exifObj : null
      var needExif = (useSharedGps || (exifObj && orientation !== 1))

      var resultBlob = watermarkedBlob

      if (needExif) {
        // Blob → dataURL（临时，仅用于 piexif）
        var tempDataUrl = await blobToDataUrl(watermarkedBlob)
        watermarkedBlob = null  // 释放 Blob 引用

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

        // 校验最终 dataURL 有效性（防止 insertExif 损坏数据）
        if (!finalDataUrl || finalDataUrl.length < 100 || finalDataUrl === 'data:,') {
          log('  ⚠️ EXIF插入后数据异常，使用原始水印数据', 'warn')
        } else {
          // dataURL → Blob 存储
          resultBlob = dataUrlToBlob(finalDataUrl)
        }
        finalDataUrl = null  // 释放 dataURL 引用
      }

      var resultBlobUrl = URL.createObjectURL(resultBlob)
      state.processed.set(key, { blob: resultBlob, blobUrl: resultBlobUrl })

      log('  ✅ 完成 (' + (Date.now() - fileStart) + 'ms) 大小=' + Math.round(resultBlob.size / 1024) + 'KB', 'ok')

    } catch (e) {
      log('  ❌ 失败: ' + e.message, 'err')
      console.error('[处理失败] ' + file.name, e)
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
    progressFill.style.width = (done / total * 100) + '%'
    progressText.textContent = done + ' / ' + total + ' 已处理'
  }

  var totalCost = Date.now() - state.startTime
  log('---')
  log('🎉 全部完成！' + state.processed.size + '/' + total + ' 张成功，耗时 ' + (totalCost / 1000).toFixed(1) + 's', 'ok')
  progressText.textContent = '完成！' + state.processed.size + '/' + total + ' 张'

  state.processing = false
  processBtn.disabled = false
  document.getElementById('downloadBtn').disabled = state.processed.size === 0
  document.getElementById('albumBtn').disabled = state.processed.size === 0

  updateUI()
  showToast('处理完成！' + state.processed.size + ' 张照片已加水印')
}

// ===== 生成压缩包 =====
async function downloadAll() {
  if (state.processed.size === 0) return

  var downloadBtn = document.getElementById('downloadBtn')
  downloadBtn.disabled = true
  downloadBtn.textContent = '⏳ 打包中...'

  try {
    var zip = new JSZip()
    var folder = zip.folder('watermarked')

    state.processed.forEach(function(obj, key) {
      if (!obj || !obj.blob || obj.blob.size === 0) {
        log('[下载] 跳过无效数据: ' + key, 'warn')
        return
      }
      var fileName = key.replace(/_\d+$/, '.jpg')
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
    // 优先使用 Web Share API（iOS Safari 原生分享表单，可保存到相册）
    if (navigator.share && navigator.canShare) {
      var files = []
      state.processed.forEach(function(obj, key) {
        if (!obj || !obj.blob) return
        var fileName = key.replace(/_\d+$/, '.jpg')
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
      entries.push({ blobUrl: obj.blobUrl, fileName: key.replace(/_\d+$/, '.jpg') })
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
  albumBtn.textContent = '📲 保存到相册'
}

// ===== 导出调试信息 =====
function exportDebugInfo() {
  var config = getConfig()
  var now = new Date()

  var debugInfo = {
    exportTime: now.toISOString(),
    userAgent: navigator.userAgent,
    language: navigator.language,
    platform: navigator.platform,
    cookieEnabled: navigator.cookieEnabled,
    onLine: navigator.onLine,
    screenSize: screen.width + '×' + screen.height,
    windowSize: window.innerWidth + '×' + window.innerHeight,

    config: config,

    fileCount: state.files.length,
    files: state.files.map(function(f) {
      var key = f.name + '_' + f.size
      var exif = state.exifData.get(key)
      return {
        name: f.name,
        sizeKB: Math.round(f.size / 1024),
        type: f.type,
        lastModified: new Date(f.lastModified).toISOString(),
        hasGps: !!(exif && exif.gps),
        gpsWgs84: (exif && exif.gps) ? { lat: exif.gps.lat.toFixed(6), lng: exif.gps.lng.toFixed(6) } : null,
        exifDate: exif ? exif.date : null,
        processed: state.processed.has(key)
      }
    }),

    processedCount: state.processed.size,
    hasLocation: !!state.currentLocation,
    locationGcj02: state.currentLocation ? { lng: state.currentLocation.lng.toFixed(6), lat: state.currentLocation.lat.toFixed(6) } : null,

    logs: []
  }

  // 收集日志区域内容
  var logArea = document.getElementById('logArea')
  if (logArea) {
    var logLines = logArea.querySelectorAll('div')
    for (var i = 0; i < logLines.length; i++) {
      debugInfo.logs.push(logLines[i].textContent)
    }
  }

  // 生成 JSON 文件并下载
  var jsonStr = JSON.stringify(debugInfo, null, 2)
  var blob = new Blob([jsonStr], { type: 'application/json' })
  var url = URL.createObjectURL(blob)
  var a = document.createElement('a')
  a.href = url
  a.download = 'watermark-debug-' + formatDateCompact(now) + '.json'
  document.body.appendChild(a)
  a.click()
  setTimeout(function() {
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }, 100)

  showToast('调试信息已导出')
  log('[导出] 调试信息已导出 ' + debugInfo.fileCount + ' 张照片，' + debugInfo.logs.length + ' 条日志', 'ok')
}

// ===== 配置 =====
function getConfig() {
  return {
    projectName: document.getElementById('projectName').value.trim(),
    address: document.getElementById('addressText').value.trim(),
    remark: document.getElementById('remarkText').value.trim(),
    amapKey: document.getElementById('amapKey').value.trim(),
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
    if (saved.amapKey) document.getElementById('amapKey').value = saved.amapKey
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

// ===== 工具函数 =====

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
  var logArea = document.getElementById('logArea')
  if (!logArea) return
  var cls = level === 'ok' ? 'log-ok' : level === 'warn' ? 'log-warn' : level === 'err' ? 'log-err' : ''
  var line = document.createElement('div')
  line.className = cls
  line.textContent = msg
  logArea.appendChild(line)
  logArea.scrollTop = logArea.scrollHeight
}

function showToast(msg) {
  var toast = document.getElementById('toast')
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
document.querySelectorAll('#projectName,#addressText,#remarkText,#amapKey,#coordsText,#dateText').forEach(function(el) {
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
  var amapKey = document.getElementById('amapKey').value.trim()
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
