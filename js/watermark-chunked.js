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

const WatermarkChunked = (() => {

  const BAR_H = 800
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

  // ============================================================
  // 主入口
  // ============================================================

  async function addWatermarkChunked(jpegArrayBuffer, config, forceScale) {
    // 路径一：Canvas + toBlob（浏览器原生编码器，必要时等比缩放/缩小解码）
    try {
      var result = await encodeViaCanvas(jpegArrayBuffer, config, forceScale)
      if (result) return result
    } catch (e) {
      console.warn('[分块水印] Canvas路径失败，降级到jpeg-js:', e.message)
    }

    // 路径二：jpeg-js 像素拼接（仅浏览器硬限制无法创建 Canvas 时）
    return encodeViaJpegJs(jpegArrayBuffer, config)
  }

  // ============================================================
  // 路径一：Canvas + toBlob
  // ============================================================

  async function encodeViaCanvas(jpegArrayBuffer, config, forceScale) {
    // 1. 轻量获取原图尺寸（不创建大 bitmap，避免超大图在 iOS 上直接解码失败/内存溢出）
    var imgBlob = new Blob([jpegArrayBuffer], { type: 'image/jpeg' })
    var dims = await getImageSize(imgBlob)
    if (!dims || !dims.w || !dims.h) {
      console.error('[分块水印-Canvas] 无法获取原图尺寸')
      return null
    }
    var imgW = dims.w
    var imgH = dims.h

    // 2. 计算安全缩放比例（支持外部强制缩放 forceScale，用于降级重试）
    var scale = computeScale(imgW, imgH, forceScale)
    var targetW = Math.max(1, Math.round(imgW * scale))
    var targetH = Math.max(1, Math.round(imgH * scale))

    // 3. 用 resize 选项直接解码到目标尺寸（关键：避免超大 bitmap 解码失败/内存溢出）
    var imgBitmap = null
    try {
      if (typeof createImageBitmap === 'function') {
        imgBitmap = await createImageBitmap(imgBlob, {
          resizeWidth: targetW, resizeHeight: targetH, resizeQuality: 'high'
        })
      }
    } catch (e) {
      console.warn('[分块水印-Canvas] resize 解码不支持/失败，进入缩小自救:', e.message)
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
        console.error('[分块水印-Canvas] ImageBitmap 解码失败:', e2.message)
        return null
      }
    }

    var bmpW = imgBitmap.width
    var bmpH = imgBitmap.height
    var outBarH = Math.max(1, Math.round(BAR_H * (bmpW / imgW)))

    if (scale < 0.999) {
      console.log('[分块水印-Canvas] 原图 ' + imgW + 'x' + imgH + ' 等比缩放至 ' + bmpW + 'x' + bmpH + ' (scale=' + scale.toFixed(2) + ')')
    } else {
      console.log('[分块水印-Canvas] 原图 ' + imgW + 'x' + imgH + ' (' + Math.round(jpegArrayBuffer.byteLength / 1024) + 'KB)')
    }

    // 4. 画信息栏（按原图宽度绘制，合成时缩放到最终宽度）
    var barCanvas = drawInfoBar(imgW, config)

    // 5. Canvas 合成（始终走原生编码）
    var canvas = document.createElement('canvas')
    canvas.width = bmpW
    canvas.height = bmpH + outBarH
    var ctx = canvas.getContext('2d')
    ctx.drawImage(imgBitmap, 0, 0)
    ctx.drawImage(barCanvas, 0, 0, imgW, BAR_H, 0, bmpH, bmpW, outBarH)

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
      console.error('[分块水印-Canvas] toBlob 返回无效结果')
      return null
    }

    var ratio = (blob.size / jpegArrayBuffer.byteLength * 100).toFixed(0)
    console.log('[分块水印-Canvas] 完成，输出 ' + Math.round(blob.size / 1024) + 'KB (原图 ' + Math.round(jpegArrayBuffer.byteLength / 1024) + 'KB, ' + ratio + '%)')
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
    var fullPx = imgW * (imgH + BAR_H)
    var scale = 1
    if (fullPx > MAX_CANVAS_PIXELS) {
      scale = Math.sqrt(MAX_CANVAS_PIXELS / fullPx)
    }
    var safeTotalH = (imgH + BAR_H) * scale
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

  async function encodeViaJpegJs(jpegArrayBuffer, config) {
    var jpegData = new Uint8Array(jpegArrayBuffer)
    var rawImage
    try {
      rawImage = jpeg.decode(jpegData, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true })
    } catch (e) {
      console.error('[分块水印-jpegJs] 解码失败:', e.message)
      return null
    }

    var imgW = rawImage.width
    var imgH = rawImage.height
    if (!imgW || !imgH) {
      console.error('[分块水印-jpegJs] 无法获取尺寸')
      return null
    }

    console.log('[分块水印-jpegJs] 原图 ' + imgW + 'x' + imgH + ', 像素 ' + Math.round(rawImage.data.length / 1024 / 1024) + 'MB')

    // 画信息栏
    var barCanvas = drawInfoBar(imgW, config)
    var barCtx = barCanvas.getContext('2d')
    var barPixels = barCtx.getImageData(0, 0, imgW, BAR_H).data

    barCanvas.width = 1
    barCanvas.height = 1
    barCanvas = null

    // 拼接像素
    var totalH = imgH + BAR_H
    var mergedData
    try {
      mergedData = new Uint8Array(imgW * totalH * 4)
    } catch (e) {
      console.error('[分块水印-jpegJs] 内存不足')
      rawImage = null
      return null
    }

    mergedData.set(rawImage.data, 0)
    rawImage = null
    mergedData.set(barPixels, imgW * imgH * 4)
    barPixels = null

    // jpeg-js 编码：用较低的固定质量（jpeg-js 高效低，q=60 已足够）
    // 不追求与原图大小完全一致，只保证不爆内存
    var encoded
    try {
      encoded = jpeg.encode({ data: mergedData, width: imgW, height: totalH }, 60)
    } catch (e) {
      console.error('[分块水印-jpegJs] 编码失败:', e.message)
      mergedData = null
      return null
    }
    mergedData = null

    var blob = new Blob([encoded.data], { type: 'image/jpeg' })
    console.log('[分块水印-jpegJs] 完成，输出 ' + Math.round(blob.size / 1024) + 'KB')
    return blob
  }

  // ============================================================
  // 共用：绘制信息栏（返回小 Canvas）
  // ============================================================

  function drawInfoBar(imgW, config) {
    var barCanvas = document.createElement('canvas')
    barCanvas.width = imgW
    barCanvas.height = BAR_H
    var ctx = barCanvas.getContext('2d')

    // 白底
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, imgW, BAR_H)

    // 顶部分割线
    ctx.strokeStyle = '#1a73e8'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(imgW, 0)
    ctx.stroke()

    // 地图区域尺寸
    var hasMapImg = config.showMap && config.mapImg
    var mapMargin = Math.round(imgW * 0.01)
    var mapSize = 700
    var mapAreaW = mapSize + mapMargin * 2

    // 标题
    var titleFontSize = 100
    ctx.save()
    ctx.font = 'bold ' + titleFontSize + 'px ' + FONT_FAMILY
    ctx.fillStyle = '#000000'
    ctx.textBaseline = 'top'
    ctx.fillText('勘察记录', PADDING, PADDING)

    var titleBottom = PADDING + titleFontSize + 12
    ctx.strokeStyle = '#1a73e8'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(PADDING, titleBottom)
    ctx.lineTo(PADDING + ctx.measureText('勘察记录').width, titleBottom)
    ctx.stroke()
    ctx.restore()

    // 信息条目
    var items = buildItems(config)
    var textAreaWidth = imgW - mapAreaW - PADDING * 2
    var colGap = 32
    var colWidth = (textAreaWidth - colGap) / 2
    var colStartY = titleBottom + 36
    var labelFontSize = 36
    var valueFontSize = 52
    var itemHeight = 110
    var perCol = Math.ceil(items.length / 2)
    drawLabelValueColumn(ctx, items.slice(0, perCol), PADDING, colStartY, colWidth, labelFontSize, valueFontSize, itemHeight, FONT_FAMILY)
    drawLabelValueColumn(ctx, items.slice(perCol), PADDING + colWidth + colGap, colStartY, colWidth, labelFontSize, valueFontSize, itemHeight, FONT_FAMILY)

    // 右侧地图
    var mapX = imgW - mapSize - mapMargin
    var mapY = (BAR_H - mapSize) / 2

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
      ctx.font = '36px ' + FONT_FAMILY
      ctx.fillStyle = '#999999'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('地图不可用', mapX + mapSize / 2, mapY + mapSize / 2)
      ctx.restore()
    }

    return barCanvas
  }

  // ============================================================
  // 辅助函数
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

  function drawLabelValueColumn(ctx, items, x, startY, maxWidth, labelFontSize, valueFontSize, itemHeight, fontFamily) {
    ctx.save()
    ctx.textBaseline = 'top'
    items.forEach(function(item, i) {
      var y = startY + i * itemHeight
      ctx.font = labelFontSize + 'px ' + fontFamily
      ctx.fillStyle = '#888888'
      ctx.fillText(item.label, x, y)
      ctx.font = valueFontSize + 'px ' + fontFamily
      ctx.fillStyle = '#000000'
      var valueText = item.value
      var maxValWidth = maxWidth - 4
      if (ctx.measureText(valueText).width > maxValWidth) {
        while (valueText.length > 0 && ctx.measureText(valueText + '…').width > maxValWidth) {
          valueText = valueText.slice(0, -1)
        }
        valueText += '…'
      }
      ctx.fillText(valueText, x, y + labelFontSize + 6)
    })
    ctx.restore()
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
