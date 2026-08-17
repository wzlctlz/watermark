#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成水印相机书签/桌面图标套件（SVG + 多尺寸 PNG + ICO）。
SVG 作为现代浏览器首选（矢量、任意 DPI 清晰）；PNG/ICO 作为兼容性兜底。
"""
from PIL import Image, ImageDraw, ImageFilter
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SVG_CONTENT = r'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#10b981"/>
      <stop offset="0.48" stop-color="#14b8a6"/>
      <stop offset="1" stop-color="#06b6d4"/>
    </linearGradient>
    <linearGradient id="lens" x1="0.3" y1="0.2" x2="0.8" y2="0.9">
      <stop offset="0" stop-color="#ecfeff"/>
      <stop offset="0.55" stop-color="#67e8f9"/>
      <stop offset="1" stop-color="#0e7490"/>
    </linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="10" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- 圆角渐变背景 -->
  <rect x="28" y="28" width="456" height="456" rx="108" fill="url(#bg)"/>
  <rect x="28" y="28" width="456" height="456" rx="108" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="10"/>

  <!-- 相机主体 -->
  <g filter="url(#glow)">
    <rect x="116" y="190" width="280" height="188" rx="48" fill="#ffffff" fill-opacity="0.96"/>
    <rect x="192" y="154" width="128" height="52" rx="18" fill="#ffffff" fill-opacity="0.9"/>
  </g>

  <!-- 镜头 -->
  <g filter="url(#soft)">
    <circle cx="256" cy="284" r="96" fill="#0f172a" fill-opacity="0.22"/>
    <circle cx="256" cy="284" r="84" fill="#f8fafc"/>
    <circle cx="256" cy="284" r="66" fill="url(#lens)"/>
    <circle cx="256" cy="284" r="34" fill="#0f172a" fill-opacity="0.68"/>
    <circle cx="240" cy="268" r="12" fill="#ffffff" fill-opacity="0.9"/>
  </g>

  <!-- 闪光灯 -->
  <circle cx="356" cy="218" r="12" fill="#fbbf24" filter="url(#soft)"/>

  <!-- 定位/水印徽章 -->
  <g transform="translate(380, 132)" filter="url(#glow)">
    <circle cx="0" cy="0" r="46" fill="#f59e0b"/>
    <circle cx="0" cy="0" r="38" fill="#fbbf24"/>
    <path d="M0 -16 C -12 -16 -20 -6 -20 6 C -20 20 -6 32 0 38 C 6 32 20 20 20 6 C 20 -6 12 -16 0 -16 Z" fill="#ffffff"/>
    <circle cx="0" cy="5" r="7" fill="#f59e0b"/>
  </g>
</svg>'''


def lerp(a, b, t):
    return a + (b - a) * t


def gradient_bg(size):
    """对角 Emerald -> Teal -> Cyan 渐变，带圆角遮罩。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = int(size * 0.055)
    radius = int(size * 0.21)

    # 绘制对角渐变底色
    grad = Image.new('RGBA', (size, size))
    gdraw = ImageDraw.Draw(grad)
    c0, c1, c2 = (16, 185, 129), (20, 184, 166), (6, 182, 212)
    for y in range(size):
        for x in range(size):
            # 沿对角线 t
            t = (x + y) / (2 * (size - 1))
            if t <= 0.5:
                r = lerp(c0[0], c1[0], t * 2)
                g = lerp(c0[1], c1[1], t * 2)
                b = lerp(c0[2], c1[2], t * 2)
            else:
                r = lerp(c1[0], c2[0], (t - 0.5) * 2)
                g = lerp(c1[1], c2[1], (t - 0.5) * 2)
                b = lerp(c1[2], c2[2], (t - 0.5) * 2)
            grad.putpixel((x, y), (int(r), int(g), int(b), 255))

    mask = Image.new('L', (size, size), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=255)
    img.paste(grad, (0, 0), mask)
    # 白色边框
    mdraw2 = ImageDraw.Draw(img)
    mdraw2.rounded_rectangle(
        [pad, pad, size - pad, size - pad], radius=radius,
        outline=(255, 255, 255, 56), width=max(2, size // 120)
    )
    return img


def drop_shadow(size, shape_drawer, blur, color=(0, 0, 0, 90)):
    """通用投影工厂：shape_drawer 在一张空白图上绘制形状。"""
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    shape_drawer(shadow)
    shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
    return shadow


def draw_rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def make_png(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    img.alpha_composite(gradient_bg(size))

    draw = ImageDraw.Draw(img)

    # 相机机身
    body_box = [int(size * 0.227), int(size * 0.371), int(size * 0.773), int(size * 0.738)]
    body_radius = int(size * 0.094)
    bump_box = [int(size * 0.375), int(size * 0.301), int(size * 0.625), int(size * 0.371)]
    bump_radius = int(size * 0.035)

    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle(body_box, radius=body_radius, fill=(0, 0, 0, 90))
    sdraw.rounded_rectangle(bump_box, radius=bump_radius, fill=(0, 0, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(int(size * 0.035)))
    img.alpha_composite(shadow)

    draw.rounded_rectangle(body_box, radius=body_radius, fill=(255, 255, 255, 245))
    draw.rounded_rectangle(bump_box, radius=bump_radius, fill=(255, 255, 255, 230))

    # 镜头
    cx, cy = size // 2, int(size * 0.555)
    lens_r = int(size * 0.188)

    lens_shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    lsdraw = ImageDraw.Draw(lens_shadow)
    lsdraw.ellipse([cx - lens_r, cy - lens_r, cx + lens_r, cy + lens_r], fill=(0, 0, 0, 70))
    lens_shadow = lens_shadow.filter(ImageFilter.GaussianBlur(int(size * 0.025)))
    img.alpha_composite(lens_shadow)

    draw.ellipse([cx - lens_r, cy - lens_r, cx + lens_r, cy + lens_r], fill=(15, 23, 42, 45))
    inner_r = int(lens_r * 0.875)
    draw.ellipse([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r], fill=(248, 250, 252, 255))

    # 镜头径向渐变
    grad_r = int(lens_r * 0.66)
    lens_grad = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    lgdraw = ImageDraw.Draw(lens_grad)
    c_in = (236, 254, 255)
    c_mid = (103, 232, 249)
    c_out = (14, 116, 144)
    for r in range(grad_r, -1, -1):
        t = r / grad_r if grad_r else 0
        if t < 0.5:
            rr = lerp(c_out[0], c_mid[0], t * 2)
            gg = lerp(c_out[1], c_mid[1], t * 2)
            bb = lerp(c_out[2], c_mid[2], t * 2)
        else:
            rr = lerp(c_mid[0], c_in[0], (t - 0.5) * 2)
            gg = lerp(c_mid[1], c_in[1], (t - 0.5) * 2)
            bb = lerp(c_mid[2], c_in[2], (t - 0.5) * 2)
        lgdraw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(int(rr), int(gg), int(bb), 255))
    img.alpha_composite(lens_grad)

    # 镜头内圈 + 高光
    dark_r = int(lens_r * 0.354)
    draw.ellipse([cx - dark_r, cy - dark_r, cx + dark_r, cy + dark_r], fill=(15, 23, 42, 175))
    hl_x, hl_y = cx - int(lens_r * 0.21), cy - int(lens_r * 0.21)
    hl_r = int(lens_r * 0.13)
    draw.ellipse([hl_x - hl_r, hl_y - hl_r, hl_x + hl_r, hl_y + hl_r], fill=(255, 255, 255, 225))

    # 闪光灯
    fx, fy = int(size * 0.695), int(size * 0.426)
    f_r = int(size * 0.023)
    draw.ellipse([fx - f_r, fy - f_r, fx + f_r, fy + f_r], fill=(251, 191, 36, 255))

    # 定位/水印徽章
    bx, by = int(size * 0.742), int(size * 0.258)
    badge_r = int(size * 0.082)
    badge_shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    bdraw = ImageDraw.Draw(badge_shadow)
    bdraw.ellipse([bx - badge_r, by - badge_r, bx + badge_r, by + badge_r], fill=(0, 0, 0, 75))
    badge_shadow = badge_shadow.filter(ImageFilter.GaussianBlur(int(size * 0.018)))
    img.alpha_composite(badge_shadow)

    draw.ellipse([bx - badge_r, by - badge_r, bx + badge_r, by + badge_r], fill=(245, 158, 11, 255))
    draw.ellipse(
        [bx - int(badge_r * 0.82), by - int(badge_r * 0.82), bx + int(badge_r * 0.82), by + int(badge_r * 0.82)],
        fill=(251, 191, 36, 255)
    )
    # 白色定位钉
    pin_points = []
    for angle in range(0, 360, 6):
        a = math.radians(angle - 90)
        if 0 <= angle <= 180:
            pr = badge_r * 0.42
        else:
            pr = badge_r * 0.24
        px = bx + pr * math.cos(a)
        py = by + pr * math.sin(a) + int(badge_r * 0.10)
        pin_points.append((px, py))
    draw.polygon(pin_points, fill=(255, 255, 255, 240))
    draw.ellipse(
        [bx - int(badge_r * 0.16), by + int(badge_r * 0.04) - int(badge_r * 0.16),
         bx + int(badge_r * 0.16), by + int(badge_r * 0.04) + int(badge_r * 0.16)],
        fill=(245, 158, 11, 255)
    )

    return img


def main():
    # 1. SVG 矢量图标（现代浏览器/高分屏首选）
    with open(os.path.join(ROOT, 'favicon.svg'), 'w', encoding='utf-8') as f:
        f.write(SVG_CONTENT)

    # 2. 多尺寸 PNG
    sizes = [16, 32, 180, 192, 512]
    filenames = {
        16: 'favicon-16x16.png',
        32: 'favicon-32x32.png',
        180: 'apple-touch-icon.png',
        192: 'icon-192.png',
        512: 'icon-512.png',
    }
    for s in sizes:
        im = make_png(s)
        im.save(os.path.join(ROOT, filenames[s]), optimize=True)

    # 3. 多尺寸 ICO（兼容旧版 IE/Edge 书签）
    im32 = make_png(32)
    im16 = make_png(16)
    im48 = make_png(48)
    im48.save(
        os.path.join(ROOT, 'favicon.ico'),
        format='ICO',
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=[im32, im16]
    )

    print('图标生成完成：')
    for s in sizes:
        print('  -', filenames[s])
    print('  - favicon.ico')
    print('  - favicon.svg')


if __name__ == '__main__':
    main()
