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

  updateUI()
  showToast('已添加 ' + unique.length + ' 张照片')
}

// ===== 更新 UI =====
function updateUI() {
  var grid = document.getElementById('photoGrid')
  var photoCount = document.getElementById('photoCount')
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

  photoCount.textContent = state.files.length

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

    item.innerHTML = '<img src="' + thumbUrl + '" loading="lazy" alt="' + file.name + '">' + badgeHtml + '<div class="filename">' + file.name + '</div>'
    if (state.selectMode) {
      item.addEventListener('click', function() { selectPhotoForInfo(idx) })
    } else {
      item.addEventListener('click', function() { showPreview(file, exif, isProcessed) })
    }
    grid.appendChild(item)
  })
}

// ===== 预览 =====
function showPreview(file, exif, isProcessed) {
  var key = file.name + '_' + file.size
  var modal = document.getElementById('previewModal')
  var img = document.getElementById('previewImg')
  var info = document.getElementById('previewInfo')

  if (isProcessed) {
    img.src = state.processed.get(key)
  } else {
    img.src = URL.createObjectURL(file)
  }

  var infoHtml = '<span>📁 ' + file.name + '</span>'
  infoHtml += '<span>📦 ' + Math.round(file.size / 1024) + ' KB</span>'
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
      try {
        var bitmap = await createImageBitmap(file)
        imgInput = bitmap
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

      var watermarkedDataUrl = Watermark.addWatermark(imgInput, wmConfig)
      if (!watermarkedDataUrl) {
        throw new Error('水印绘制失败')
      }

      // 注入EXIF
      var finalDataUrl = watermarkedDataUrl
      var exifObj = exifResult && exifResult.exifObj ? exifResult.exifObj : null

      if (useSharedGps) {
        exifObj = ExifUtils.injectGps(exifObj, state.sharedWgsLng, state.sharedWgsLat)
        finalDataUrl = ExifUtils.insertExif(watermarkedDataUrl, exifObj)
      } else if (exifObj && orientation !== 1) {
        var orientTag = (piexif.ImageIFD && piexif.ImageIFD.Orientation) || 274
        if (!exifObj['0th']) exifObj['0th'] = {}
        exifObj['0th'][orientTag] = 1
        finalDataUrl = ExifUtils.insertExif(watermarkedDataUrl, exifObj)
      }

      state.processed.set(key, finalDataUrl)
      log('  ✅ 完成 (' + (Date.now() - fileStart) + 'ms)', 'ok')

    } catch (e) {
      log('  ❌ 失败: ' + e.message, 'err')
      console.error('[处理失败] ' + file.name, e)
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

    state.processed.forEach(function(dataUrl, key) {
      var fileName = key.replace(/_\d+$/, '.jpg')
      var bytes = ExifUtils.dataUrlToUint8Array(dataUrl)
      folder.file(fileName, bytes, { binary: true })
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
      var idx = 0
      state.processed.forEach(function(dataUrl, key) {
        var byteString = atob(dataUrl.split(',')[1])
        var mimeString = dataUrl.split(',')[0].split(':')[1].split(';')[0]
        var ab = new ArrayBuffer(byteString.length)
        var ia = new Uint8Array(ab)
        for (var i = 0; i < byteString.length; i++) {
          ia[i] = byteString.charCodeAt(i)
        }
        var fileName = key.replace(/_\d+$/, '.jpg')
        files.push(new File([ab], fileName, { type: 'image/jpeg' }))
        idx++
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

    // 降级方案：逐张下载
    log('[相册] 浏览器不支持直接保存到相册，将逐张下载', 'warn')
    var count = 0
    state.processed.forEach(function(dataUrl, key) {
      var fileName = key.replace(/_\d+$/, '.jpg')
      var a = document.createElement('a')
      a.href = dataUrl
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      count++
    })
    log('[相册] 已下载 ' + count + ' 张照片', 'ok')
    showToast('已下载 ' + count + ' 张照片，请在相册中查看')
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
    if (saved.address) document.getElementById('addressText').value = saved.address
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
    }
    if (saved.coordsText) document.getElementById('coordsText').value = saved.coordsText
    if (saved.dateText) document.getElementById('dateText').value = saved.dateText
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
// zoom输入框自动保存
document.getElementById('mapZoom').addEventListener('input', function() {
  // 限制范围3-18
  var v = parseInt(this.value)
  if (v < 3) this.value = 3
  if (v > 18) this.value = 18
  saveConfig()
})
document.querySelectorAll('input[type="checkbox"]').forEach(function(el) {
  el.addEventListener('change', saveConfig)
})
