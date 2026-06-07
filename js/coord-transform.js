/**
 * coord-transform.js - GCJ02(高德) ↔ WGS84(GPS) 坐标转换
 * 迭代逼近法，精度 <1米
 */

const CoordTransform = (() => {
  const PI = Math.PI
  const A = 6378245.0        // 长半轴
  const EE = 0.00669342162296594323  // 扁率

  function _transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0
    return ret
  }

  function _transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0
    return ret
  }

  /**
   * WGS84 → GCJ02
   * @param {number} wgsLng - WGS84经度
   * @param {number} wgsLat - WGS84纬度
   * @returns {{lng: number, lat: number}} GCJ02坐标
   */
  function wgs84ToGcj02(wgsLng, wgsLat) {
    let dLat = _transformLat(wgsLng - 105.0, wgsLat - 35.0)
    let dLng = _transformLng(wgsLng - 105.0, wgsLat - 35.0)
    const radLat = wgsLat / 180.0 * PI
    let magic = Math.sin(radLat)
    magic = 1 - EE * magic * magic
    const sqrtMagic = Math.sqrt(magic)
    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI)
    dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI)
    return { lng: wgsLng + dLng, lat: wgsLat + dLat }
  }

  /**
   * GCJ02 → WGS84（迭代逼近法，精度<1米）
   * @param {number} gcjLng - GCJ02经度
   * @param {number} gcjLat - GCJ02纬度
   * @returns {{lng: number, lat: number}} WGS84坐标
   */
  function gcj02ToWgs84(gcjLng, gcjLat) {
    let wgsLng = gcjLng, wgsLat = gcjLat
    for (let i = 0; i < 5; i++) {
      const gcj = wgs84ToGcj02(wgsLng, wgsLat)
      wgsLng += gcjLng - gcj.lng
      wgsLat += gcjLat - gcj.lat
    }
    return { lng: wgsLng, lat: wgsLat }
  }

  return { wgs84ToGcj02, gcj02ToWgs84 }
})()
