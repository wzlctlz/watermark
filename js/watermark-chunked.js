/**
 * watermark-chunked.js - 分块水印（优先 Canvas toBlob）
 * @version 2026-06-11-v2  (Canvas toBlob 优先，文件大小接近原图)
 *
 * 策略：
 *   1. 优先 Canvas + toBlob（浏览器原生编码，文件小、速度快）
 *   2. Canvas 装不下时降级到 jpeg-js 像素拼接
 *
 * 关于输出文件大小：
 *   toBlob() 不指定质量时，浏览器默认质量通常与原图编码质量接近
 *   输出比原图大 10-30% 是正常的（多了信息栏像素）
 *   不要用 jpeg-js 做主编码器——同质量参数下文件大 2-3 倍
 */

const WatermarkChunked = (() => {

  const BAR_H = 800
  const PADDING = 48
  const FONT_FAMILY = '"YouYuan", "幼圆", "FangSong", "Microsoft YaHei", "PingFang SC", sans-serif'

  // 内存安全上限：ImageBitmap + Canvas 总内存估算
  // 手机浏览器 GPU 内存通常 67-256MB，保守限制
  const MAX_CANVAS_PIXELS = 14 * 1024 * 1024  // 14MP

  // ============================================================
  // 主入口
  // ============================================================

  async function addWatermarkChunked(jpegArrayBuffer, config) {
    // 路径一：Canvas + toBlob（浏览器原生编码器）
    try {
      var result = await encodeViaCanvas(jpegArrayBuffer, config)
      if (result) return result
    } catch (e) {
      console.warn('[分块水印] Canvas路径失败，降级到jpeg-js:', e.message)
    }

    // 路径二：jpeg-js 像素拼接（超大图降级）
    return encodeViaJpegJs(jpegArrayBuffer, config)
  }

  // ============================================================
  // 路径一：Canvas + toBlob
  // ============================================================

  async function encodeViaCanvas(jpegArrayBuffer, config) {
    // 1. 用 ImageBitmap 加载原图（不占 JS 堆内存）
    var imgBlob = new Blob([jpegArrayBuffer], { type: 'image/jpeg' })
    var imgBitmap
    try {
      imgBitmap = await createImageBitmap(imgBlob)
    } catch (e) {
      console.error('[分块水印-Canvas] ImageBitmap 解码失败:', e.message)
      return null
    }

    var imgW = imgBitmap.width
    var imgH = imgBitmap.height
    var totalH = imgH + BAR_H

    // 2. Canvas 尺寸安全检查
    if (imgW * totalH > MAX_CANVAS_PIXELS) {
      console.log('[分块水印-Canvas] Canvas尺寸超限 (' + imgW + 'x' + totalH + '=' + Math.round(imgW*totalH/1024/1024) + 'MP)，走降级路径')
      imgBitmap.close()
      return null
    }

    console.log('[分块水印-Canvas] 原图 ' + imgW + 'x' + imgH + ' (' + Math.round(jpegArrayBuffer.byteLength / 1024) + 'KB)')

    // 3. 画信息栏（小 Canvas，内存小）
    var barCanvas = drawInfoBar(imgW, config)

    // 4. 全尺寸 Canvas 合成
    var canvas = document.createElement('canvas')
    canvas.width = imgW
    canvas.height = totalH
    var ctx = canvas.getContext('2d')
    ctx.drawImage(imgBitmap, 0, 0)
    ctx.drawImage(barCanvas, 0, imgH)

    // 立即释放源，节省内存
    imgBitmap.close()
    barCanvas.width = 1
    barCanvas.height = 1
    barCanvas = null

    // 5. toBlob 编码 —— 不指定质量，让浏览器用默认质量
    //    浏览器默认质量通常与原图编码质量接近，输出大小合理
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
