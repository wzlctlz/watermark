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
  async function addWatermark(input, config) {
    const canvas = document.getElementById('watermarkCanvas')
    const ctx = canvas.getContext('2d')

    // 支持 Image / ImageBitmap / Canvas 输入
    const imgW = input.naturalWidth || input.width || 0
    const imgH = input.naturalHeight || input.height || 0
    if (!imgW || !imgH) {
      console.error('[addWatermark] 无法获取图片尺寸')
      return null
    }
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

    // 10. 安全导出 — 使用 toBlob() 替代 toDataURL()
    // toBlob() 生成的 Blob 由浏览器管理，可交换到磁盘，不占用 JS 堆内存
    // toDataURL() 生成的 base64 字符串存在 JS 堆中，12MP 照片约占 8-15MB，批量处理时容易 OOM
    try {
      var blob = await canvasToBlob(canvas, 'image/jpeg', 1.0)
      if (!blob || blob.size < 100) {
        console.warn('Canvas.toBlob 返回空数据，尝试降级导出')
        return await fallbackWithoutMap(input, config, barH, imgW, imgH, padding, fontFamily)
      }
      return blob
    } catch (e) {
      console.warn('Canvas.toBlob 失败：', e.message)
      return await fallbackWithoutMap(input, config, barH, imgW, imgH, padding, fontFamily)
    }
  }

  /**
   * canvas → Blob（Promise 包装 toBlob）
   */
  function canvasToBlob(canvas, type, quality) {
    return new Promise(function(resolve) {
      canvas.toBlob(function(blob) {
        resolve(blob)
      }, type, quality)
    })
  }

  /**
   * 降级方案：不含地图
   */
  async function fallbackWithoutMap(input, config, barH, imgW, imgH, padding, fontFamily) {
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
      var blob = await canvasToBlob(canvas, 'image/jpeg', 1.0)
      if (!blob || blob.size < 100) {
        console.error('降级导出也返回空数据')
        return null
      }
      return blob
    } catch (e2) {
      console.error('降级导出也失败：', e2.message)
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
   * 高德 API 调用调试反馈：写入应用内日志窗口 + console
   */
  function amapDebug(msg, level) {
    try {
      if (typeof window !== 'undefined' && typeof window.log === 'function') {
        window.log('[高德] ' + msg, level || 'info')
      }
    } catch (e) { /* 忽略日志组件异常 */ }
    if (level === 'err') console.error('[高德] ' + msg)
    else if (level === 'warn') console.warn('[高德] ' + msg)
    else console.log('[高德] ' + msg)
  }

  /**
   * 加载高德静态地图
   *
   * 高德静态地图服务返回 Access-Control-Allow-Origin: *，因此可直接以
   * crossOrigin='anonymous' 跨域加载（图像 CORS 干净，可绘入 canvas 导出），
   * 无需任何第三方代理。原 corsproxy.io 代理已失效（返回 401），已移除。
   */
  function loadMapImage(gcjLng, gcjLat, amapKey, size, zoom) {
    return new Promise(function(resolve) {
      if (!amapKey) { amapDebug('未配置 Key，跳过地图加载', 'warn'); resolve(null); return }

      var z = zoom || 15
      var mapSize = Math.min(size || 350, 1024)
      var apiUrl = 'https://restapi.amap.com/v3/staticmap?location=' + gcjLng + ',' + gcjLat +
        '&zoom=' + z + '&size=' + mapSize + '*' + mapSize +
        '&scale=2&markers=large,,:' + gcjLng + ',' + gcjLat + '&key=' + amapKey

      window.__lastMapApiUrl = apiUrl
      amapDebug('请求静态地图: ' + apiUrl, 'info')

      var fetchOpts = { mode: 'cors' }
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        fetchOpts.signal = AbortSignal.timeout(12000)
      }

      fetch(apiUrl, fetchOpts)
        .then(function(res) {
          var ctype = (res.headers && res.headers.get) ? (res.headers.get('content-type') || '') : ''
          amapDebug('静态地图响应: HTTP ' + res.status + ' / ' + ctype, res.ok ? 'ok' : 'err')
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.blob().then(function(blob) {
            // 高德在 Key 异常时返回 200 + JSON 错误体（非图片），需解析出原因
            if (!/^image\//.test(blob.type || ctype)) {
              return blob.text().then(function(text) {
                var info = text
                try {
                  var j = JSON.parse(text)
                  info = 'status=' + j.status + ', info=' + j.info + (j.infocode ? (', infocode=' + j.infocode) : '')
                } catch (e) { /* 非 JSON，保留原文 */ }
                throw new Error('返回非图片内容: ' + info)
              })
            }
            return blob
          })
        })
        .then(function(blob) {
          amapDebug('获取到地图图片: ' + blob.size + ' 字节 (' + blob.type + ')', 'ok')
          var img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = function() {
            amapDebug('地图解码成功: ' + this.naturalWidth + 'x' + this.naturalHeight, 'ok')
            this._apiUrl = apiUrl
            this._taintsCanvas = false
            resolve(this)
          }
          img.onerror = function() {
            amapDebug('地图图片解码失败（可能格式/CORS 问题）', 'err')
            resolve(null)
          }
          img.src = URL.createObjectURL(blob)
        })
        .catch(function(err) {
          amapDebug('静态地图加载失败: ' + err.message +
            '｜排查：① 浏览器网络能否访问 restapi.amap.com；② Key 是否在高德控制台启用；③ Key 是否设置了 IP 白名单（静态地图走服务端 IP）', 'err')
          resolve(null)
        })
    })
  }

  return { addWatermark: addWatermark, loadMapImage: loadMapImage }
})()
