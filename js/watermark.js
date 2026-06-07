/**
 * watermark.js - Canvas 水印绘制
 * 底部白条布局：原图 + 底部800px信息栏（不遮图片）
 * 左侧文字(标签上/值下) + 右侧静态地图(700x700)
 * 幼圆字体，白底黑字，标题"勘察记录"大两号
 */

const Watermark = (() => {

  /**
   * 给图片添加水印
   */
  function addWatermark(input, config) {
    const canvas = document.getElementById('watermarkCanvas')
    const ctx = canvas.getContext('2d')

    // 支持 Image / ImageBitmap / Canvas 输入
    const imgW = input.naturalWidth || input.width
    const imgH = input.naturalHeight || input.height
    const barH = 800

    canvas.width = imgW
    canvas.height = imgH + barH

    // 1. 绘制原图
    ctx.drawImage(input, 0, 0, imgW, imgH)

    // 2. 绘制底部白条
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, imgH, imgW, barH)

    // 3. 顶部装饰线
    ctx.strokeStyle = '#1a73e8'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(0, imgH)
    ctx.lineTo(imgW, imgH)
    ctx.stroke()

    // 4. 字体
    const padding = 48
    const fontFamily = '"YouYuan", "\u5E7C\u5706", "FangSong", "Microsoft YaHei", "PingFang SC", sans-serif'

    // 5. 地图区域（右侧）— 固定700x700，API请求350x350(scale=2实际返回700x700)
    const hasMapImg = config.showMap && config.mapImg
    const mapMargin = Math.round(imgW * 0.01)
    const mapSize = 700
    const mapAreaW = mapSize + mapMargin * 2

    // 6. 绘制标题 "勘察记录"
    const titleFontSize = 100
    ctx.save()
    ctx.font = 'bold ' + titleFontSize + 'px ' + fontFamily
    ctx.fillStyle = '#000000'
    ctx.textBaseline = 'top'
    const titleX = padding
    const titleY = imgH + padding
    ctx.fillText('\u52D8\u5BDF\u8BB0\u5F55', titleX, titleY)

    // 标题下方蓝色装饰线
    const titleBottom = titleY + titleFontSize + 12
    ctx.strokeStyle = '#1a73e8'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(titleX, titleBottom)
    ctx.lineTo(titleX + ctx.measureText('\u52D8\u5BDF\u8BB0\u5F55').width, titleBottom)
    ctx.stroke()
    ctx.restore()

    // 7. 构建信息条目
    const items = buildItems(config)

    // 8. 两列布局 — 标签在上(灰色小字)，值在下(黑色大字)
    const textAreaWidth = imgW - mapAreaW - padding * 2
    const colGap = 32
    const colWidth = (textAreaWidth - colGap) / 2
    const colStartY = titleBottom + 36
    const labelFontSize = 36
    const valueFontSize = 52
    const itemHeight = 110

    // 尽量均匀分配：优先填满左列
    const perCol = Math.ceil(items.length / 2)
    const leftItems = items.slice(0, perCol)
    const rightItems = items.slice(perCol)

    drawLabelValueColumn(ctx, leftItems, padding, colStartY, colWidth, labelFontSize, valueFontSize, itemHeight, fontFamily)
    drawLabelValueColumn(ctx, rightItems, padding + colWidth + colGap, colStartY, colWidth, labelFontSize, valueFontSize, itemHeight, fontFamily)

    // 9. 右侧静态地图
    const mapX = imgW - mapSize - mapMargin
    const mapY = imgH + (barH - mapSize) / 2

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
      ctx.font = '36px ' + fontFamily
      ctx.fillStyle = '#999999'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('\u5730\u56FE\u4E0D\u53EF\u7528', mapX + mapSize / 2, mapY + mapSize / 2)
      ctx.restore()
    }

    // 10. 安全导出
    try {
      return canvas.toDataURL('image/jpeg', 1.0)
    } catch (e) {
      console.warn('Canvas.toDataURL \u5931\u8D25\uFF1A', e.message)
      return fallbackWithoutMap(input, config, barH, imgW, imgH, padding, fontFamily)
    }
  }

  /**
   * 降级方案：不含地图
   */
  function fallbackWithoutMap(input, config, barH, imgW, imgH, padding, fontFamily) {
    // 创建全新的canvas，避免iOS Safari上已污染canvas无法重置的问题
    const oldCanvas = document.getElementById('watermarkCanvas')
    const canvas = document.createElement('canvas')
    canvas.id = 'watermarkCanvas'
    canvas.style.display = 'none'
    oldCanvas.parentNode.replaceChild(canvas, oldCanvas)
    const ctx = canvas.getContext('2d')
    canvas.width = imgW
    canvas.height = imgH + barH

    ctx.drawImage(input, 0, 0, imgW, imgH)
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, imgH, imgW, barH)

    ctx.strokeStyle = '#1a73e8'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(0, imgH)
    ctx.lineTo(imgW, imgH)
    ctx.stroke()

    const titleFontSize = 100
    ctx.save()
    ctx.font = 'bold ' + titleFontSize + 'px ' + fontFamily
    ctx.fillStyle = '#000000'
    ctx.textBaseline = 'top'
    ctx.fillText('\u52D8\u5BDF\u8BB0\u5F55', padding, imgH + padding)
    ctx.restore()

    const items = buildItems(config)
    const colGap = 32
    const colWidth = (imgW - padding * 3) / 2
    const colStartY = imgH + padding + titleFontSize + 48
    const labelFontSize = 36
    const valueFontSize = 52
    const itemHeight = 110
    const perCol = Math.ceil(items.length / 2)
    drawLabelValueColumn(ctx, items.slice(0, perCol), padding, colStartY, colWidth, labelFontSize, valueFontSize, itemHeight, fontFamily)
    drawLabelValueColumn(ctx, items.slice(perCol), padding + colWidth + colGap, colStartY, colWidth, labelFontSize, valueFontSize, itemHeight, fontFamily)

    try {
      return canvas.toDataURL('image/jpeg', 1.0)
    } catch (e2) {
      console.error('\u964D\u7EA7\u5BFC\u51FA\u4E5F\u5931\u8D25\uFF1A', e2.message)
      return null
    }
  }

  /**
   * 构建信息条目
   */
  function buildItems(config) {
    const items = []
    if (config.showProject && config.projectName) {
      items.push({ label: '\u9879\u76EE\u540D\u79F0', value: config.projectName })
    }
    if (config.showAddress && config.address) {
      items.push({ label: '\u5730\u5740', value: config.address })
    }
    if (config.showCoords && config.coordStr) {
      items.push({ label: 'GCJ坐标', value: config.coordStr })
    }
    if (config.showDate && config.dateStr) {
      items.push({ label: '\u65E5\u671F', value: config.dateStr })
    }
    if (config.showRemark && config.remark) {
      items.push({ label: '\u5907\u6CE8', value: config.remark })
    }
    return items
  }

  /**
   * 绘制单列：标签在上(灰色小字) + 值在下(黑色大字)
   */
  function drawLabelValueColumn(ctx, items, x, startY, maxWidth, labelFontSize, valueFontSize, itemHeight, fontFamily) {
    ctx.save()
    ctx.textBaseline = 'top'

    items.forEach(function(item, i) {
      const y = startY + i * itemHeight

      // 标签（灰色小字）
      ctx.font = labelFontSize + 'px ' + fontFamily
      ctx.fillStyle = '#888888'
      ctx.fillText(item.label, x, y)

      // 值（黑色大字）
      ctx.font = valueFontSize + 'px ' + fontFamily
      ctx.fillStyle = '#000000'
      let valueText = item.value
      const maxValWidth = maxWidth - 4
      if (ctx.measureText(valueText).width > maxValWidth) {
        while (valueText.length > 0 && ctx.measureText(valueText + '\u2026').width > maxValWidth) {
          valueText = valueText.slice(0, -1)
        }
        valueText += '\u2026'
      }
      ctx.fillText(valueText, x, y + labelFontSize + 6)
    })

    ctx.restore()
  }

  /**
   * 绘制圆角矩形路径
   */
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

  /**
   * 加载高德静态地图
   */
  function loadMapImage(gcjLng, gcjLat, amapKey, size, zoom) {
    return new Promise(function(resolve) {
      if (!amapKey) { resolve(null); return }

      var z = zoom || 15
      const mapSize = Math.min(size || 350, 1024)
      const apiUrl = 'https://restapi.amap.com/v3/staticmap?location=' + gcjLng + ',' + gcjLat + '&zoom=' + z + '&size=' + mapSize + '*' + mapSize + '&scale=2&markers=large,,:' + gcjLng + ',' + gcjLat + '&key=' + amapKey
      const proxyUrl = 'https://corsproxy.io/?' + encodeURIComponent(apiUrl)

      window.__lastMapApiUrl = apiUrl
      console.log('[地图] API地址:', apiUrl)
      console.log('[地图] 代理地址:', proxyUrl)

      var fetchOpts = {}
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        fetchOpts.signal = AbortSignal.timeout(10000)
      }

      fetch(proxyUrl, fetchOpts)
        .then(function(res) {
          console.log('[地图] 代理响应:', res.status)
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.blob()
        })
        .then(function(blob) {
          console.log('[地图] blob成功, 类型:', blob.type, '大小:', blob.size)
          var reader = new FileReader()
          reader.onloadend = function() {
            var dataUrl = reader.result
            var img = new Image()
            img.onload = function() {
              console.log('[地图] 加载成功:', this.naturalWidth, 'x', this.naturalHeight)
              this._fromProxy = true
              this._apiUrl = apiUrl
              resolve(this)
            }
            img.onerror = function() {
              console.warn('[地图] dataURL加载失败')
              loadDirect(apiUrl, resolve)
            }
            img.src = dataUrl
          }
          reader.onerror = function() {
            console.warn('[地图] FileReader失败')
            loadDirect(apiUrl, resolve)
          }
          reader.readAsDataURL(blob)
        })
        .catch(function(proxyErr) {
          console.warn('[地图] 代理失败:', proxyErr.message)
          loadDirect(apiUrl, resolve)
        })
    })
  }

  function loadDirect(apiUrl, resolve) {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = function() {
      console.log('[地图] 直接加载成功(跨域)')
      this._taintsCanvas = true
      this._apiUrl = apiUrl
      resolve(this)
    }
    img.onerror = function() {
      console.warn('[地图] 直接加载失败')
      resolve(null)
    }
    img.src = apiUrl
  }

  return { addWatermark: addWatermark, loadMapImage: loadMapImage }
})()
