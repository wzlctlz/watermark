/**
 * exif-utils.js - EXIF 读取/写入工具
 * 基于 piexifjs 库，浏览器端完整保留和写入 EXIF GPS
 */

const ExifUtils = (() => {

  /**
   * 从 File 对象读取 EXIF 数据
   * @param {File} file
   * @returns {Promise<{exifObj: object|null, gps: {lat:number, lng:number, latRef:string, lngRef:string}|null, date: string|null}>}
   */
  async function readExif(file) {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = function(e) {
        const dataUrl = e.target.result
      try {
        const exifObj = piexif.load(dataUrl)

        // 提取 GPS
        const gps = extractGps(exifObj)

        // 提取拍摄日期
        const date = extractDate(exifObj)

        // 提取方向标签
        const orientation = extractOrientation(exifObj)

        resolve({ exifObj, gps, date, orientation })
      } catch (err) {
        // 无 EXIF 或解析失败
        resolve({ exifObj: null, gps: null, date: null, orientation: 1 })
      }
    }
    reader.onerror = () => resolve({ exifObj: null, gps: null, date: null, orientation: 1 })
      reader.readAsDataURL(file)
    })
  }

  /**
   * 从 piexif 对象中提取 GPS 坐标（WGS84 十进制度）
   */
  function extractGps(exifObj) {
    if (!exifObj || !exifObj.GPS) return null
    const gps = exifObj.GPS

    try {
      const latRat = gps[piexif.GPSIFD.GPSLatitude]
      const lngRat = gps[piexif.GPSIFD.GPSLongitude]
      const latRef = gps[piexif.GPSIFD.GPSLatitudeRef] || 'N'
      const lngRef = gps[piexif.GPSIFD.GPSLongitudeRef] || 'E'

      if (!latRat || !lngRat) return null

      const lat = rationalToDecimal(latRat) * (latRef === 'S' ? -1 : 1)
      const lng = rationalToDecimal(lngRat) * (lngRef === 'W' ? -1 : 1)

      if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) return null

      return { lat, lng, latRef, lngRef }
    } catch (e) {
      return null
    }
  }

  /**
   * EXIF 有理数（度/分/秒）转十进制度
   * piexif 返回格式: [[num, den], [num, den], [num, den]]
   */
  function rationalToDecimal(rat) {
    if (!Array.isArray(rat) || rat.length < 3) return NaN
    const deg = rat[0][0] / rat[0][1]
    const min = rat[1][0] / rat[1][1]
    const sec = rat[2][0] / rat[2][1]
    return deg + min / 60.0 + sec / 3600.0
  }

  /**
   * 十进制度转 EXIF 有理数（度/分/秒）
   */
  function decimalToRational(decimal, precision) {
    precision = precision || 1000000
    const absDeg = Math.abs(decimal)
    const deg = Math.floor(absDeg)
    const minFloat = (absDeg - deg) * 60
    const min = Math.floor(minFloat)
    const secFloat = (minFloat - min) * 60
    const secNum = Math.round(secFloat * precision)
    
    return [
      [deg, 1],
      [min, 1],
      [secNum, precision]
    ]
  }

  /**
   * 提取 EXIF Orientation（方向标签）
   * 1=正常，2=水平翻转，3=旋转180°，4=垂直翻转，
   * 5=水平翻转+270°，6=顺时针90°，7=水平翻转+90°，8=逆时针90°
   */
  function extractOrientation(exifObj) {
    if (!exifObj || !exifObj['0th']) return 1
    // piexif.ImageIFD.Orientation 可能未定义，直接用标签号 274
    const tag = (piexif.ImageIFD && piexif.ImageIFD.Orientation) || 274
    const val = exifObj['0th'][tag]
    return (typeof val === 'number' && val >= 1 && val <= 8) ? val : 1
  }

  /**
   * 提取拍摄日期
   */
  function extractDate(exifObj) {
    if (!exifObj) return null
    // 优先 ExifIFD.DateTimeOriginal
    const dto = exifObj.Exif && exifObj.Exif[piexif.ExifIFD.DateTimeOriginal]
    if (dto) return dto
    // 回退到 IFD0.DateTime
    const dt = exifObj['0th'] && exifObj['0th'][piexif.ImageIFD.DateTime]
    return dt || null
  }

  /**
   * 将 WGS84 坐标注入 EXIF GPS IFD
   * @param {object} exifObj - piexif 对象（可为 null，会自动创建）
   * @param {number} wgsLng - WGS84 经度
   * @param {number} wgsLat - WGS84 纬度
   * @returns {object} 更新后的 piexif 对象
   */
  function injectGps(exifObj, wgsLng, wgsLat) {
    if (!exifObj) {
      exifObj = {
        '0th': {},
        'Exif': {},
        'GPS': {},
        '1st': {},
        'Interop': {}
      }
    }
    if (!exifObj.GPS) exifObj.GPS = {}
    if (!exifObj['0th']) exifObj['0th'] = {}

    const latRef = wgsLat >= 0 ? 'N' : 'S'
    const lngRef = wgsLng >= 0 ? 'E' : 'W'

    exifObj.GPS[piexif.GPSIFD.GPSLatitudeRef] = latRef
    exifObj.GPS[piexif.GPSIFD.GPSLongitudeRef] = lngRef
    exifObj.GPS[piexif.GPSIFD.GPSLatitude] = decimalToRational(Math.abs(wgsLat))
    exifObj.GPS[piexif.GPSIFD.GPSLongitude] = decimalToRational(Math.abs(wgsLng))
    // GPS 版本 ID
    exifObj.GPS[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0]

    // 重置 Orientation 为 1（水印后的图片已经是正确方向，避免查看器再次旋转）
    const orientTag = (piexif.ImageIFD && piexif.ImageIFD.Orientation) || 274
    exifObj['0th'][orientTag] = 1

    return exifObj
  }

  /**
   * 将 piexif 对象写入 dataURL
   * @param {string} dataUrl - 原始图片 dataURL
   * @param {object} exifObj - piexif 对象
   * @returns {string} 带 EXIF 的 dataURL
   */
  function insertExif(dataUrl, exifObj) {
    try {
      const exifBytes = piexif.dump(exifObj)
      return piexif.insert(exifBytes, dataUrl)
    } catch (e) {
      console.warn('插入EXIF失败:', e)
      return dataUrl
    }
  }

  /**
   * dataURL → Uint8Array (用于 JSZip)
   */
  function dataUrlToUint8Array(dataUrl) {
    const base64 = dataUrl.split(',')[1]
    const binaryStr = atob(base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }
    return bytes
  }

  /**
   * File → dataURL
   */
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = e => resolve(e.target.result)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  /**
   * File → Image (获取原始尺寸)
   */
  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        resolve(img)
        // 不立即释放，后续还需要用
      }
      img.onerror = reject
      img.src = url
    })
  }

  return {
    readExif, extractGps, extractDate, extractOrientation,
    injectGps, insertExif,
    dataUrlToUint8Array, fileToDataUrl, fileToImage,
    decimalToRational, rationalToDecimal
  }
})()
