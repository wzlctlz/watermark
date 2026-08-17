/**
 * watermark-chunked.js - 分块水印（优先 Canvas toBlob）
 * @version 2026-08-17-v2  (resize 解码自救 + forceScale 强制缩放，杜绝超大图降级到暴涨文件)
 *
 * 策略：
 *   1. 优先 Canvas + toBlob（浏览器原生编码，文件小、速度快）
 *   2. 先用轻量方式取尺寸，再用 createImageBitmap 的 resize 选项直接解码到安全尺寸
 *      —— 超大图不再因解码失败直接放弃，也不会回退到会暴涨文件的旧 Canvas 路径
 *   3. 支持 forceScale 强制缩放（app.js 降级重试时调用，保证文件大小正常、几乎无感画质损失）
 *
 * 关于输出文件大小：
 *   toBlob() 不指定质量时，浏览器默认质量通常与原图编码质量接近
 *   输出比原图大 10-30% 是正常的（多了信息栏像素）
 *   不要用 jpeg-js 做主编码器——同质量参数下文件大 2-3 倍且极慢
 */

// ============================================================
// 全局调试记录器（供 app.js / watermark.js / 本模块共享）
// 所有模块的处理日志、每一步指标都会写入 window.WMDebug，
// 由 app.js 的「导出调试信息」生成结构化 JSON，便于定位 bug。
// 设计原则：
//   - 记录一律结构化 {t(时间戳), level, source, msg} 或带步骤的数据，
//     不再只靠 DOM 文本抓取（旧版导出的纯文本行已无法满足排障）。
//   - 每个函数都用 try/catch 包裹，自身绝不抛错、绝不影响主流程。
// ============================================================
(function () {
  if (window.WMDebug) return  // 避免热重载时重复初始化
  window.WMDebug = {
    schemaVersion: 4,
    appVersion: 'v2026-08-17-perf',
    startedAt: Date.now(),
    entries: [],   // {t, level, source, msg}
    photos: {},    // key -> { key, fileName, steps:[...], ...摘要字段 }
    events: []      // {t, name, data}
  }

  // 统一日志入口：写入结构化 entries，并同步打到浏览器控制台
  window.WMLog = function (level, msg, source) {
    try {
      var d = window.WMDebug
      if (!d) return
      var lv = (level === 'err' || level === 'error') ? 'error'
        : (level === 'warn' || level === 'warning') ? 'warn'
        : (level === 'ok' || level === 'success') ? 'ok'
        : (level === 'info' || !level) ? 'info'
        : String(level)
      d.entries.push({ t: Date.now(), level: lv, source: source || 'app', msg: String(msg) })
      var c = (lv === 'error') ? console.error : (lv === 'warn') ? console.warn : console.log
      try { c.call(console, '[' + (source || 'app') + '] ' + msg) } catch (e) {}
    } catch (e) {}
  }

  // 合并写入某张照片的摘要字段
  window.WMPhoto = function (key, patch) {
    try {
      var d = window.WMDebug
      if (!d || !key) return
      if (!d.photos[key]) d.photos[key] = { key: key, steps: [] }
      var p = d.photos[key]
      if (patch) for (var k in patch) if (patch.hasOwnProperty(k)) p[k] = patch[k]
    } catch (e) {}
  }

  // 追加某张照片的一个处理步骤（最终汇成时间线）
  window.WMPhotoStep = function (key, stage, data) {
    try {
      var d = window.WMDebug
      if (!d || !key) return
      if (!d.photos[key]) d.photos[key] = { key: key, steps: [] }
      var p = d.photos[key]
      var step = { t: Date.now(), stage: stage }
      if (data) for (var k in data) if (data.hasOwnProperty(k)) step[k] = data[k]
      p.steps.push(step)
    } catch (e) {}
  }

  // 记录离散事件（处理开始/结束、地图加载等）
  window.WMEvent = function (name, data) {
    try {
      var d = window.WMDebug
      if (!d) return
      d.events.push({ t: Date.now(), name: name, data: data || null })
    } catch (e) {}
  }

  // ============================================================
  // 高精度性能计时器（按照片 key 记录各阶段耗时与数据量，用于分析卡顿/发热来源）
  //   WMPerf.start(key)        开始一张照片的计时（app.js 在处理循环开头调用）
  //   WMPerf.stage(key,name,d) 记录一个阶段结束，自动计算距上一阶段的毫秒差（performance.now 高精度）
  //   WMPerf.end(key)          结束计时，返回 {totalMs, stages:[{name,ms,bytesIn,bytesOut,px,heapMB}], heapStartMB, heapPeakMB}
  // 阶段名带 [fs0.6] 前缀表示 forceScale 降级重试；[jpegjs] 前缀表示走 jpeg-js 降级路径
  // 每个阶段自动采样 JS 堆内存（仅 Chrome 支持 performance.memory），便于发现内存上涨导致的 GC 抖动(卡顿/发热)
  // ============================================================
  function _wmNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
  }
  function _wmHeapMB() {
    try {
      if (typeof performance !== 'undefined' && performance.memory && performance.memory.usedJSHeapSize) {
        return +(performance.memory.usedJSHeapSize / 1048576).toFixed(1)
      }
    } catch (e) {}
    return null
  }
  window.WMPerf = {
    _p: {},
    start: function (key) {
      try { if (!key) return; this._p[key] = { start: _wmNow(), last: _wmNow(), stages: [], heapStart: _wmHeapMB() } } catch (e) {}
    },
    stage: function (key, name, data) {
      try {
        if (!key) return 0
        var p = this._p[key]
        if (!p) { this.start(key); p = this._p[key] }
        var t = _wmNow()
        var dur = +(t - p.last).toFixed(1)
        p.last = t
        var rec = { name: name, ms: dur }
        if (data) for (var k in data) if (data.hasOwnProperty(k)) rec[k] = data[k]
        var h = _wmHeapMB(); if (h != null) rec.heapMB = h
        p.stages.push(rec)
        if (typeof window.onWMPerfStage === 'function') {
          try { window.onWMPerfStage(key, name, dur, rec) } catch (e2) {}
        }
        return dur
      } catch (e) { return 0 }
    },
    end: function (key) {
      try {
        var p = this._p[key]
        if (!p) return null
        var total = +(_wmNow() - p.start).toFixed(1)
        delete this._p[key]
        var peak = p.heapStart
        for (var i = 0; i < p.stages.length; i++) {
          var hv = p.stages[i].heapMB
          if (hv != null && (peak == null || hv > peak)) peak = hv
        }
        return { totalMs: total, stages: p.stages, heapStartMB: p.heapStart, heapPeakMB: peak }
      } catch (e) { return null }
    }
  }
})()

const WatermarkChunked = (() => {

  const EST_BAR_H = 1000  // 信息栏高度估算（实际高度由 computeBarLayout 动态计算，这里仅用于像素安全上限估算，取偏大值更稳妥）
  const PADDING = 48
  const FONT_FAMILY = '"YouYuan", "幼圆", "FangSong", "Microsoft YaHei", "PingFang SC", sans-serif'

  // 设备感知的 Canvas 像素安全上限（RGBA 4字节/像素）
  // 依据 navigator.deviceMemory（GB）粗略估算可承受的画布像素数
  var _devMem = (typeof navigator !== 'undefined' && navigator.deviceMemory) ? navigator.deviceMemory : 4
  var MAX_CANVAS_PIXELS = _devMem >= 8 ? 130 * 1024 * 1024   // 桌面 8GB+：覆盖 1 亿像素(约117MP)照片
    : _devMem >= 4 ? 70 * 1024 * 1024                        // 4-7GB
    : 30 * 1024 * 1024                                       // 低端设备
  // 浏览器对单边长的硬上限（多数引擎约 16384，保守取 16383）
  var MAX_CANVAS_DIM = 16383

  // 把编码上限也暴露到调试记录（供环境诊断）
  if (window.WMDebug) {
    window.WMDebug.limits = {
      MAX_CANVAS_PIXELS: MAX_CANVAS_PIXELS,
      MAX_CANVAS_DIM: MAX_CANVAS_DIM,
      deviceMemoryGB: _devMem
    }
  }

  // ============================================================
  // 主入口
  // ============================================================

  async function addWatermarkChunked(jpegArrayBuffer, config, forceScale, key) {
    // 路径一：Canvas + toBlob（浏览器原生编码器，必要时等比缩放/缩小解码）
    try {
      var result = await encodeViaCanvas(jpegArrayBuffer, config, forceScale, key)
      if (result) return result
    } catch (e) {
      WMLog('warn', '[分块水印] Canvas路径失败，降级到jpeg-js: ' + e.message, 'chunked')
      if (key) WMPhotoStep(key, 'canvas-fallback-to-jpegjs', { error: e.message })
    }

    // 路径二：jpeg-js 像素拼接（仅浏览器硬限制无法创建 Canvas 时）
    return encodeViaJpegJs(jpegArrayBuffer, config, key)
  }

  // ============================================================
  // 路径一：Canvas + toBlob
  // ============================================================

  async function encodeViaCanvas(jpegArrayBuffer, config, forceScale, key) {
    var encodeStart = Date.now()
    var tag = forceScale ? '[fs' + forceScale + ']' : ''
    // 1. 轻量获取原图尺寸（不创建大 bitmap，避免超大图在 iOS 上直接解码失败/内存溢出）
    var imgBlob = new Blob([jpegArrayBuffer], { type: 'image/jpeg' })
    var dims = await getImageSize(imgBlob)
    if (!dims || !dims.w || !dims.h) {
      WMLog('err', '[分块水印-Canvas] 无法获取原图尺寸', 'chunked')
      if (key) WMPhotoStep(key, 'canvas-fail', { reason: 'no-dimensions' })
      return null
    }
    var imgW = dims.w
    var imgH = dims.h
    if (key) WMPerf.stage(key, tag + 'getSize', {
      bytesIn: jpegArrayBuffer.byteLength, originalW: imgW, originalH: imgH
    })

    // 2. 计算安全缩放比例（支持外部强制缩放 forceScale，用于降级重试）
    var scale = computeScale(imgW, imgH, forceScale)
    var targetW = Math.max(1, Math.round(imgW * scale))
    var targetH = Math.max(1, Math.round(imgH * scale))

    if (key) WMPhotoStep(key, 'canvas-decode-start', {
      originalW: imgW, originalH: imgH, scale: +scale.toFixed(3),
      targetW: targetW, targetH: targetH, forceScale: forceScale || null
    })

    // 3. 用 resize 选项直接解码到目标尺寸（关键：避免超大 bitmap 解码失败/内存溢出）
    var imgBitmap = null
    try {
      if (typeof createImageBitmap === 'function') {
        imgBitmap = await createImageBitmap(imgBlob, {
          resizeWidth: targetW, resizeHeight: targetH, resizeQuality: 'high'
        })
      }
    } catch (e) {
      WMLog('warn', '[分块水印-Canvas] resize 解码不支持/失败，进入缩小自救: ' + e.message, 'chunked')
      if (key) WMPhotoStep(key, 'canvas-resize-fail', { error: e.message })
    }
    // resize 失败 → 逐级缩小再解码（自愈超大图，避免直接放弃）
    if (!imgBitmap) {
      var rescueScales = [0.5, 0.25, 0.1]
      for (var ri = 0; ri < rescueScales.length && !imgBitmap; ri++) {
        try {
          imgBitmap = await createImageBitmap(imgBlob, {
            resizeWidth: Math.max(1, Math.round(imgW * rescueScales[ri])),
            resizeHeight: Math.max(1, Math.round(imgH * rescueScales[ri])),
            resizeQuality: 'high'
          })
        } catch (e3) { /* 尝试更小尺寸 */ }
      }
    }
    if (!imgBitmap) {
      try {
        imgBitmap = await createImageBitmap(imgBlob)
      } catch (e2) {
        WMLog('err', '[分块水印-Canvas] ImageBitmap 解码失败: ' + e2.message, 'chunked')
        if (key) WMPhotoStep(key, 'canvas-fail', { reason: 'bitmap-decode-error', error: e2.message })
        return null
      }
    }

    var bmpW = imgBitmap.width
    var bmpH = imgBitmap.height
    // 信息栏高度自适应（按原图宽度计算布局，合成时等比缩放到最终宽度）
    var barLayout = computeBarLayout(imgW, config)
    var barH = barLayout.height
    var outBarH = Math.max(1, Math.round(barH * (bmpW / imgW)))
    if (key) WMPerf.stage(key, tag + 'decode', {
      targetW: bmpW, targetH: bmpH, px: bmpW * bmpH, scale: +scale.toFixed(3)
    })

    if (scale < 0.999) {
      WMLog('info', '[分块水印-Canvas] 原图 ' + imgW + 'x' + imgH + ' 等比缩放至 ' + bmpW + 'x' + bmpH + ' (scale=' + scale.toFixed(2) + ')', 'chunked')
    } else {
      WMLog('info', '[分块水印-Canvas] 原图 ' + imgW + 'x' + imgH + ' (' + Math.round(jpegArrayBuffer.byteLength / 1024) + 'KB)', 'chunked')
    }

    // 4. 画信息栏（按原图宽度绘制，合成时缩放到最终宽度）
    var barCanvas = drawInfoBar(imgW, config, barLayout)
    if (key) WMPerf.stage(key, tag + 'drawBar', { barW: imgW, barH: barH })

    // 5. Canvas 合成（始终走原生编码）
    var canvas = document.createElement('canvas')
    canvas.width = bmpW
    canvas.height = bmpH + outBarH
    var ctx = canvas.getContext('2d')
    ctx.drawImage(imgBitmap, 0, 0)
    ctx.drawImage(barCanvas, 0, 0, imgW, barH, 0, bmpH, bmpW, outBarH)
    if (key) WMPerf.stage(key, tag + 'composite', {
      canvasW: bmpW, canvasH: bmpH + outBarH, px: bmpW * (bmpH + outBarH)
    })

    // 立即释放源，节省内存
    if (imgBitmap.close) imgBitmap.close()
    barCanvas.width = 1
    barCanvas.height = 1
    barCanvas = null

    // 6. toBlob 编码 —— 不指定质量，让浏览器用默认质量（与原图接近，文件大小正常）
    var blob = await canvasToBlob(canvas)

    canvas.width = 1
    canvas.height = 1
    canvas = null

    if (!blob || blob.size < 100) {
      WMLog('err', '[分块水印-Canvas] toBlob 返回无效结果', 'chunked')
      if (key) WMPhotoStep(key, 'canvas-toBlob-fail', {})
      return null
    }
    if (key) WMPerf.stage(key, tag + 'toBlob', {
      outBytes: blob.size, outPx: bmpW * (bmpH + outBarH),
      ratio: +(blob.size / jpegArrayBuffer.byteLength * 100).toFixed(0)
    })

    var ratio = (blob.size / jpegArrayBuffer.byteLength * 100).toFixed(0)
    WMLog('info', '[分块水印-Canvas] 完成，输出 ' + Math.round(blob.size / 1024) + 'KB (原图 ' + Math.round(jpegArrayBuffer.byteLength / 1024) + 'KB, ' + ratio + '%)', 'chunked')
    if (key) {
      WMPhotoStep(key, 'canvas-ok', {
        outW: bmpW, outH: bmpH, outputSizeKB: Math.round(blob.size / 1024), ratio: +ratio, encodeMs: Date.now() - encodeStart
      })
      WMPhoto(key, {
        path: 'chunked-canvas', outW: bmpW, outH: bmpH,
        scale: +scale.toFixed(3), lossless: scale >= 0.999,
        outputSizeKB: Math.round(blob.size / 1024), ratio: +ratio, encodeMs: Date.now() - encodeStart
      })
    }
    return blob
  }

  // 轻量获取图片尺寸（不创建全分辨率 bitmap）
  function getImageSize(blob) {
    return new Promise(function(resolve) {
      var url = URL.createObjectURL(blob)
      var img = new Image()
      img.onload = function() {
        var w = img.naturalWidth, h = img.naturalHeight
        URL.revokeObjectURL(url)
        resolve({ w: w, h: h })
      }
      img.onerror = function() {
        URL.revokeObjectURL(url)
        resolve(null)
      }
      img.src = url
    })
  }

  // 计算安全缩放比例（支持 forceScale 强制缩放）
  function computeScale(imgW, imgH, forceScale) {
    if (forceScale && forceScale > 0 && forceScale < 1) {
      return Math.min(1, forceScale)
    }
    var fullPx = imgW * (imgH + EST_BAR_H)
    var scale = 1
    if (fullPx > MAX_CANVAS_PIXELS) {
      scale = Math.sqrt(MAX_CANVAS_PIXELS / fullPx)
    }
    var safeTotalH = (imgH + EST_BAR_H) * scale
    if (imgW * scale > MAX_CANVAS_DIM || safeTotalH > MAX_CANVAS_DIM) {
      var dimScale = Math.min(MAX_CANVAS_DIM / (imgW * scale), MAX_CANVAS_DIM / safeTotalH)
      scale = Math.min(scale, dimScale)
    }
    return Math.min(1, Math.max(0.05, scale))
  }

  function canvasToBlob(canvas) {
    return new Promise(function(resolve) {
      canvas.toBlob(function(blob) {
        resolve(blob)
      }, 'image/jpeg')
      // 不传 quality 参数 → 浏览器默认质量
    })
  }

  // ============================================================
  // 路径二：jpeg-js 像素拼接（超大图降级）
  // ============================================================

  async function encodeViaJpegJs(jpegArrayBuffer, config, key) {
    var jpegData = new Uint8Array(jpegArrayBuffer)
    var rawImage
    try {
      rawImage = jpeg.decode(jpegData, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true })
    } catch (e) {
      WMLog('err', '[分块水印-jpegJs] 解码失败: ' + e.message, 'chunked')
      if (key) WMPhotoStep(key, 'jpegjs-decode-fail', { error: e.message })
      return null
    }

    var imgW = rawImage.width
    var imgH = rawImage.height
    if (!imgW || !imgH) {
      WMLog('err', '[分块水印-jpegJs] 无法获取尺寸', 'chunked')
      if (key) WMPhotoStep(key, 'jpegjs-fail', { reason: 'no-dimensions' })
      return null
    }
    if (key) WMPerf.stage(key, '[jpegjs]decode', { px: imgW * imgH, bytesIn: jpegArrayBuffer.byteLength })

    WMLog('info', '[分块水印-jpegJs] 原图 ' + imgW + 'x' + imgH + ', 像素 ' + Math.round(rawImage.data.length / 1024 / 1024) + 'MB', 'chunked')
    if (key) WMPhotoStep(key, 'jpegjs-decode-ok', { originalW: imgW, originalH: imgH, pixelsMB: +(rawImage.data.length / 1024 / 1024).toFixed(1) })

    // 画信息栏
    var barLayoutJ = computeBarLayout(imgW, config)
    var barCanvas = drawInfoBar(imgW, config, barLayoutJ)
    if (key) WMPerf.stage(key, '[jpegjs]drawBar', { barW: imgW, barH: barLayoutJ.height })
    var barCtx = barCanvas.getContext('2d')
    var barPixels = barCtx.getImageData(0, 0, imgW, barLayoutJ.height).data

    barCanvas.width = 1
    barCanvas.height = 1
    barCanvas = null

    // 拼接像素
    var totalH = imgH + barLayoutJ.height
    var mergedData
    try {
      mergedData = new Uint8Array(imgW * totalH * 4)
    } catch (e) {
      WMLog('err', '[分块水印-jpegJs] 内存不足', 'chunked')
      rawImage = null
      if (key) WMPhotoStep(key, 'jpegjs-fail', { reason: 'oom' })
      return null
    }

    mergedData.set(rawImage.data, 0)
    rawImage = null
    mergedData.set(barPixels, imgW * imgH * 4)
    barPixels = null
    if (key) WMPerf.stage(key, '[jpegjs]pixelMerge', { px: imgW * totalH })

    // jpeg-js 编码：用较低的固定质量（jpeg-js 高效低，q=60 已足够）
    // 不追求与原图大小完全一致，只保证不爆内存
    var encoded
    try {
      encoded = jpeg.encode({ data: mergedData, width: imgW, height: totalH }, 60)
      if (key) WMPerf.stage(key, '[jpegjs]encode', { outBytes: encoded.data.length, outPx: imgW * totalH })
    } catch (e) {
      WMLog('err', '[分块水印-jpegJs] 编码失败: ' + e.message, 'chunked')
      mergedData = null
      if (key) WMPhotoStep(key, 'jpegjs-encode-fail', { error: e.message })
      return null
    }
    mergedData = null

    var blob = new Blob([encoded.data], { type: 'image/jpeg' })
    WMLog('info', '[分块水印-jpegJs] 完成，输出 ' + Math.round(blob.size / 1024) + 'KB', 'chunked')
    if (key) {
      WMPhotoStep(key, 'jpegjs-ok', { outW: imgW, outH: totalH, outputSizeKB: Math.round(blob.size / 1024) })
      WMPhoto(key, {
        path: 'chunked-jpegjs', outW: imgW, outH: totalH, scale: 1, lossless: false,
        outputSizeKB: Math.round(blob.size / 1024), ratio: +(blob.size / jpegArrayBuffer.byteLength * 100).toFixed(0)
      })
    }
    return blob
  }

  // ============================================================
  // 共用：绘制信息栏（返回小 Canvas）
  // ============================================================

  function buildItems(config) {
    var items = []
    if (config.showProject && config.projectName) {
      items.push({ label: '项目名称', value: config.projectName })
    }
    if (config.showAddress && config.address) {
      items.push({ label: '地址', value: config.address })
    }
    if (config.showCoords && config.coordStr) {
      items.push({ label: 'GCJ坐标', value: config.coordStr })
    }
    if (config.showDate && config.dateStr) {
      items.push({ label: '日期', value: config.dateStr })
    }
    if (config.showRemark && config.remark) {
      items.push({ label: '备注', value: config.remark })
    }
    return items
  }

  // 文本按宽度换行（中文按字符断行）
  function wrapText(ctx, text, maxW) {
    if (!text) return ['']
    var lines = []
    var cur = ''
    for (var i = 0; i < text.length; i++) {
      var ch = text[i]
      var test = cur + ch
      if (cur.length > 0 && ctx.measureText(test).width > maxW) {
        lines.push(cur)
        cur = ch
      } else {
        cur = test
      }
    }
    if (cur.length > 0) lines.push(cur)
    return lines
  }

  function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

  // 计算信息栏布局：高度自适应，单栏每行一条信息，冒号对齐，标签加粗
  function computeBarLayout(imgW, config) {
    var s = imgW / 1000
    var titleFS = clampNum(Math.round(s * 8), 44, 110)
    var LABEL_FS = clampNum(Math.round(s * 5.5), 32, 82)
    var VALUE_FS = clampNum(Math.round(s * 7), 40, 96)
    var PAD = clampNum(Math.round(s * 5), 28, 72)
    var lineHeight = Math.round(VALUE_FS * 1.18)
    var itemGap = Math.round(VALUE_FS * 0.08)

    // 左右圆角安全内缩：文字整体右移，避免进入圆角被裁切
    var cornerInset = Math.round(imgW * 0.018)

    // 右侧地图区域（先给初值，稍后按竖向高度微调）
    var mapMargin = Math.round(imgW * 0.012)
    var mapGap = Math.round(imgW * 0.006) + 8
    var mapSize0 = clampNum(Math.round(imgW * 0.1), 160, 900)
    var mapAreaW = mapSize0 + mapMargin * 2

    var mCanvas = document.createElement('canvas')
    var mctx = mCanvas.getContext('2d')

    // 标签列宽：以 4 个汉字为准，少于 4 汉字的标签用空格补齐到该宽度（中文对齐）
    mctx.font = 'bold ' + LABEL_FS + 'px ' + FONT_FAMILY
    var cjkW = mctx.measureText('项').width
    var labelColW = cjkW * 4

    var items = buildItems(config)
    var maxLabelW = 0
    items.forEach(function (it) {
      maxLabelW = Math.max(maxLabelW, mctx.measureText(it.label).width)
    })
    // 列宽取「4字宽」与「最宽标签」的较大者，保证冒号不压住长标签
    var colW = Math.max(labelColW, maxLabelW)

    var textLeft = PAD + cornerInset
    var gapToColon = Math.round(imgW * 0.006) + 16
    var contentX = textLeft + colW + gapToColon

    mctx.font = VALUE_FS + 'px ' + FONT_FAMILY
    var itemsLayout = []
    var itemsTotal = 0
    items.forEach(function (it) {
      var valLines = wrapText(mctx, it.value || '', (imgW - mapAreaW - PAD) - contentX)
      var n = valLines.length
      var h = n * lineHeight + (n > 0 ? itemGap : 0)
      itemsLayout.push({ label: it.label, valLines: valLines, h: h })
      itemsTotal += h
    })

    var titleBlockH = titleFS + Math.round(titleFS * 0.28) + Math.round(titleFS * 0.22)
    var top = PAD + titleBlockH

    // 内容高度（不含地图）
    var contentH = top + itemsTotal + PAD

    // 地图尺寸：尽量填满竖向留白，但比内容高度稍小一点，不压住顶/底边框线
    var mapSize = clampNum(
      Math.round(Math.min(mapSize0, contentH - mapMargin * 2 - mapGap)),
      160, 900
    )
    var minH = mapSize + mapMargin * 2 + mapGap
    // 底部圆角留白
    var height = Math.max(contentH, minH) + cornerInset

    return {
      titleFS: titleFS, LABEL_FS: LABEL_FS, VALUE_FS: VALUE_FS, PAD: PAD,
      lineHeight: lineHeight, itemGap: itemGap,
      mapSize: mapSize, mapMargin: mapMargin, mapAreaW: mapAreaW, mapGap: mapGap,
      cornerInset: cornerInset, textLeft: textLeft, contentX: contentX,
      labelColW: labelColW, colW: colW, cjkW: cjkW,
      valueMaxW: (imgW - mapAreaW - PAD) - contentX,
      itemsLayout: itemsLayout, titleBlockH: titleBlockH, top: top, height: height
    }
  }

  function drawInfoBar(imgW, config, layout) {
    if (!layout) layout = computeBarLayout(imgW, config)
    var barCanvas = document.createElement('canvas')
    barCanvas.width = imgW
    barCanvas.height = layout.height
    var ctx = barCanvas.getContext('2d')

    // 白底
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, imgW, layout.height)

    // 顶部蓝色装饰线
    ctx.strokeStyle = '#1a73e8'
    ctx.lineWidth = Math.max(4, Math.round(imgW * 0.004))
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(imgW, 0)
    ctx.stroke()

    var PAD = layout.PAD
    var titleFS = layout.titleFS
    var textLeft = layout.textLeft

    // 标题（随圆角安全内缩右移）
    ctx.save()
    ctx.textBaseline = 'top'
    ctx.font = 'bold ' + titleFS + 'px ' + FONT_FAMILY
    ctx.fillStyle = '#0b3d91'
    ctx.fillText('勘察记录', textLeft, PAD)
    var titleW = ctx.measureText('勘察记录').width
    ctx.strokeStyle = '#1a73e8'
    ctx.lineWidth = Math.max(3, Math.round(imgW * 0.003))
    var dividerY = PAD + titleFS + Math.round(titleFS * 0.28)
    ctx.beginPath()
    ctx.moveTo(textLeft, dividerY)
    ctx.lineTo(textLeft + titleW, dividerY)
    ctx.stroke()
    ctx.restore()

    // 信息条目（单栏，每行一条，冒号对齐，标签加粗，少于4汉字用全角空格补齐到4字宽）
    var cursorY = layout.top
    ctx.save()
    ctx.textBaseline = 'top'
    var cjkW = layout.cjkW || ctx.measureText('项').width
    layout.itemsLayout.forEach(function (item) {
      // 标签（加粗），不足 4 汉字宽度则补全角空格
      ctx.font = 'bold ' + layout.LABEL_FS + 'px ' + FONT_FAMILY
      ctx.fillStyle = '#1a1a1a'
      var lbl = item.label
      var lw = ctx.measureText(lbl).width
      if (lw < layout.labelColW) {
        var padN = Math.ceil((layout.labelColW - lw) / cjkW)
        if (padN > 0) lbl = lbl + new Array(padN + 1).join('　')
      }
      ctx.fillText(lbl, textLeft, cursorY)
      // 内容（常规），首行以冒号开头，续行缩进到内容列
      ctx.font = layout.VALUE_FS + 'px ' + FONT_FAMILY
      ctx.fillStyle = '#000000'
      for (var i = 0; i < item.valLines.length; i++) {
        var text = (i === 0 ? '：' : '') + item.valLines[i]
        ctx.fillText(text, layout.contentX, cursorY + i * layout.lineHeight)
      }
      cursorY += item.h
    })
    ctx.restore()

    // 右侧地图
    var hasMapImg = config.showMap && config.mapImg
    var mapSize = layout.mapSize
    var mapMargin = layout.mapMargin
    var mapX = imgW - mapSize - mapMargin
    var mapY = (layout.height - mapSize) / 2

    if (hasMapImg) {
      ctx.save()
      ctx.fillStyle = '#e8f0fe'
      drawRoundRect(ctx, mapX - 3, mapY - 3, mapSize + 6, mapSize + 6, 10)
      ctx.fill()
      drawRoundRect(ctx, mapX, mapY, mapSize, mapSize, 8)
      ctx.clip()
      ctx.drawImage(config.mapImg, mapX, mapY, mapSize, mapSize)
      ctx.restore()
      ctx.save()
      ctx.strokeStyle = '#1a73e8'
      ctx.lineWidth = 2
      drawRoundRect(ctx, mapX, mapY, mapSize, mapSize, 8)
      ctx.stroke()
      ctx.restore()
    } else {
      ctx.save()
      ctx.fillStyle = '#f0f0f0'
      drawRoundRect(ctx, mapX, mapY, mapSize, mapSize, 8)
      ctx.fill()
      ctx.strokeStyle = '#cccccc'
      ctx.lineWidth = 1
      drawRoundRect(ctx, mapX, mapY, mapSize, mapSize, 8)
      ctx.stroke()
      ctx.font = Math.round(mapSize * 0.09) + 'px ' + FONT_FAMILY
      ctx.fillStyle = '#999999'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('地图不可用', mapX + mapSize / 2, mapY + mapSize / 2)
      ctx.restore()
    }

    return barCanvas
  }

  function drawRoundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.lineTo(x + w - r, y)
    ctx.arcTo(x + w, y, x + w, y + r, r)
    ctx.lineTo(x + w, y + h - r)
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
    ctx.lineTo(x + r, y + h)
    ctx.arcTo(x, y + h, x, y + h - r, r)
    ctx.lineTo(x, y + r)
    ctx.arcTo(x, y, x + r, y, r)
    ctx.closePath()
  }

  return { addWatermarkChunked: addWatermarkChunked }
})()
