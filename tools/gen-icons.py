#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成水印相机书签/桌面图标套件（相机 + 彩色光圈叶片样式）。
SVG 矢量图标为主，PNG/ICO 兜底兼容。
"""
from PIL import Image, ImageDraw, ImageFilter
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 设计参数（基于 512×512 视图）
PARAMS = {
    'bg_pad': 28,
    'bg_radius': 96,
    'body': (96, 216, 320, 184, 40),   # x, y, w, h, rx
    'bump': (192, 176, 128, 56, 24),   # 取景器凸起
    'button': (120, 192, 48, 32, 14),  # 左侧肩部按钮
    'lens_cx': 256,
    'lens_cy': 308,
    'lens_outer_r': 130,
    'lens_stroke': 14,
    'lens_inner_r': 122,
    'blade_r_in': 48,
    'blade_r_out': 122,
    'blade_count': 7,
    'blade_gap': 2,                    # 叶片之间间隙（度）
    'center_r': 52,
    'colors': ['#3b82f6', '#8b5cf6', '#ef4444', '#f97316', '#facc15', '#84cc16', '#06b6d4'],
}


def lerp(a, b, t):
    return a + (b - a) * t


def hex_to_rgba(hex_color, alpha=255):
    h = hex_color.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4)) + (alpha,)


def make_svg():
    """生成与 PNG 视觉一致的 SVG 矢量图标。"""
    p = PARAMS
    cx, cy = p['lens_cx'], p['lens_cy']
    n = p['blade_count']
    gap = p['blade_gap']
    sweep = 360.0 / n
    blade_a = sweep - gap
    r_in = p['blade_r_in']
    r_out = p['blade_r_out']

    def pt(cx, cy, r, deg):
        a = math.radians(deg - 90)  # 0° 指向正上方
        return (cx + r * math.cos(a), cy + r * math.sin(a))

    def sector_path(start_deg, end_deg):
        p1 = pt(cx, cy, r_in, start_deg)
        p2 = pt(cx, cy, r_out, start_deg)
        p3 = pt(cx, cy, r_out, end_deg)
        p4 = pt(cx, cy, r_in, end_deg)
        return (
            f"M {p1[0]:.1f} {p1[1]:.1f} "
            f"L {p2[0]:.1f} {p2[1]:.1f} "
            f"A {r_out} {r_out} 0 0 1 {p3[0]:.1f} {p3[1]:.1f} "
            f"L {p4[0]:.1f} {p4[1]:.1f} "
            f"A {r_in} {r_in} 0 0 0 {p1[0]:.1f} {p1[1]:.1f} Z"
        )

    blades = []
    for i, color in enumerate(p['colors']):
        start = i * sweep - sweep / 2  # 首片居中朝上
        end = start + blade_a
        blades.append(f'    <path d="{sector_path(start, end)}" fill="{color}"/>')

    bx, by, bw, bh, br = p['body']
    ux, uy, uw, uh, ur = p['bump']
    sx, sy, sw, sh, sr = p['button']

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#0f172a" flood-opacity="0.22"/>
    </filter>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f8fafc"/>
      <stop offset="1" stop-color="#e2e8f0"/>
    </linearGradient>
  </defs>

  <rect x="{p['bg_pad']}" y="{p['bg_pad']}" width="{512 - 2 * p['bg_pad']}" height="{512 - 2 * p['bg_pad']}" rx="{p['bg_radius']}" fill="url(#bgGrad)" stroke="#cbd5e1" stroke-width="6"/>

  <!-- 相机机身 -->
  <g filter="url(#shadow)">
    <rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="{br}" fill="#0f172a"/>
    <rect x="{ux}" y="{uy}" width="{uw}" height="{uh}" rx="{ur}" fill="#0f172a"/>
    <rect x="{sx}" y="{sy}" width="{sw}" height="{sh}" rx="{sr}" fill="#0f172a"/>
  </g>

  <!-- 镜头外圈 -->
  <circle cx="{cx}" cy="{cy}" r="{p['lens_outer_r']}" fill="none" stroke="#0f172a" stroke-width="{p['lens_stroke']}"/>
  <circle cx="{cx}" cy="{cy}" r="{p['lens_inner_r']}" fill="#ffffff"/>

  <!-- 彩色光圈叶片 -->
  <g>
{chr(10).join(blades)}
  </g>

  <!-- 中心光圈开口 -->
  <circle cx="{cx}" cy="{cy}" r="{p['center_r']}" fill="#ffffff"/>
</svg>'''


def make_png(size):
    """生成指定尺寸的 PNG 图标，视觉与 SVG 一致。"""
    p = PARAMS
    scale = size / 512.0

    def s(v):
        if isinstance(v, tuple):
            return tuple(int(x * scale) for x in v)
        return int(v * scale)

    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # ===== 背景（浅灰渐变 + 圆角边框） =====
    bg_pad = s(p['bg_pad'])
    bg_radius = s(p['bg_radius'])
    bg = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg)
    for y in range(size):
        t = y / (size - 1) if size > 1 else 0
        r = int(lerp(248, 226, t))
        g = int(lerp(250, 232, t))
        b = int(lerp(252, 240, t))
        bg_draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

    mask = Image.new('L', (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(
        [bg_pad, bg_pad, size - bg_pad, size - bg_pad],
        radius=bg_radius, fill=255
    )
    img.paste(bg, (0, 0), mask)
    draw.rounded_rectangle(
        [bg_pad, bg_pad, size - bg_pad, size - bg_pad],
        radius=bg_radius, outline=(203, 213, 225, 255), width=s(6)
    )

    # ===== 相机机身（带投影） =====
    bx, by, bw, bh, br = s(p['body'])
    ux, uy, uw, uh, ur = s(p['bump'])
    sx, sy, sw, sh, sr = s(p['button'])
    boxes = [
        (bx, by, bx + bw, by + bh),
        (ux, uy, ux + uw, uy + uh),
        (sx, sy, sx + sw, sy + sh),
    ]
    radiuses = [s(p['body'][4]), s(p['bump'][4]), s(p['button'][4])]

    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    for box, r in zip(boxes, radiuses):
        sdraw.rounded_rectangle(box, radius=r, fill=(15, 23, 42, 120))
    shadow = shadow.filter(ImageFilter.GaussianBlur(s(10)))
    img.alpha_composite(shadow)

    for box, r in zip(boxes, radiuses):
        draw.rounded_rectangle(box, radius=r, fill=(15, 23, 42, 255))

    # ===== 镜头外圈 + 内白底 =====
    cx, cy = s(p['lens_cx']), s(p['lens_cy'])
    outer_r = s(p['lens_outer_r'])
    inner_r = s(p['lens_inner_r'])
    draw.ellipse([cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r],
                 fill=(15, 23, 42, 255))
    draw.ellipse([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r],
                 fill=(255, 255, 255, 255))

    # ===== 彩色光圈叶片（扇环） =====
    n = p['blade_count']
    gap = p['blade_gap']
    sweep = 360.0 / n
    blade_a = sweep - gap
    r_in = s(p['blade_r_in'])
    r_out = s(p['blade_r_out'])

    for i, color in enumerate(p['colors']):
        start = i * sweep - sweep / 2
        end = start + blade_a
        pts = []
        steps = 40
        # 外弧
        for j in range(steps + 1):
            deg = start + (end - start) * j / steps
            a = math.radians(deg - 90)
            pts.append((cx + r_out * math.cos(a), cy + r_out * math.sin(a)))
        # 内弧（反向）
        for j in range(steps, -1, -1):
            deg = start + (end - start) * j / steps
            a = math.radians(deg - 90)
            pts.append((cx + r_in * math.cos(a), cy + r_in * math.sin(a)))
        draw.polygon(pts, fill=hex_to_rgba(color))

    # ===== 中心白色光圈开口 =====
    center_r = s(p['center_r'])
    draw.ellipse([cx - center_r, cy - center_r, cx + center_r, cy + center_r],
                 fill=(255, 255, 255, 255))

    return img


def main():
    # 1. SVG 矢量图标（现代浏览器/高分屏首选）
    svg_content = make_svg()
    with open(os.path.join(ROOT, 'favicon.svg'), 'w', encoding='utf-8') as f:
        f.write(svg_content)

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
