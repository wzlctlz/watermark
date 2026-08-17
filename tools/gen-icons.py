#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成水印相机书签/桌面图标套件。
严格按模板绘制：黑色相机机身 + 双侧白色横条 + 顶部双凸起 + 中心彩色螺旋光圈。
SVG 矢量图标为主，PNG/ICO 兜底兼容。
"""
from PIL import Image, ImageDraw, ImageFilter
import math
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 设计参数（基于 512×512 视图）
PARAMS = {
    'bg': '#ffffff',              # 模板为纯白背景
    'bg_radius': 0,               # 模板背景无明显圆角
    'body': (66, 180, 380, 200, 40),   # x, y, w, h, rx
    'bump_l': (92, 150, 64, 46, 20),   # 左侧小凸起
    'bump_r': (206, 118, 100, 74, 40), # 右侧大取景器凸起
    'strip_h': 14,                # 机身白色横条高度
    'strip_y1': 0.30,             # 第一条横条相对机身顶部的位置
    'strip_y2': 0.66,             # 第二条横条相对机身顶部的位置
    'lens_cx': 256,
    'lens_cy': 280,
    'lens_outer_r': 120,          # 镜头外圈半径
    'lens_stroke': 14,            # 外圈黑边宽度
    'lens_inner_r': 113,          # 黑边内侧（白底填充到此）
    'blade_r_in': 45,             # 彩色叶片内径
    'blade_r_out': 108,           # 彩色叶片外径
    'blade_count': 8,             # 模板约 8 片彩色叶片
    'blade_gap': 2,               # 叶片间间隙（度）
    'blade_twist': 9,             # 外缘相对内缘的旋转角，形成螺旋
    'center_r': 45,               # 中心白色光圈开口
    # 叶片颜色，顺时针从正上方开始：蓝/紫/暗红/红/橙/黄/绿/青
    'colors': ['#3b82f6', '#a855f7', '#991b1b', '#dc2626',
               '#f97316', '#facc15', '#84cc16', '#06b6d4'],
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
    twist = p['blade_twist']
    sweep = 360.0 / n
    blade_a = sweep - gap
    r_in = p['blade_r_in']
    r_out = p['blade_r_out']

    def pt(cx, cy, r, deg):
        a = math.radians(deg - 90)  # 0° 指向正上方
        return (cx + r * math.cos(a), cy + r * math.sin(a))

    def blade_path(start_inner, end_inner):
        start_outer = start_inner + twist
        end_outer = end_inner + twist
        p1 = pt(cx, cy, r_in, start_inner)
        p2 = pt(cx, cy, r_out, start_outer)
        p3 = pt(cx, cy, r_out, end_outer)
        p4 = pt(cx, cy, r_in, end_inner)
        return (
            f"M {p1[0]:.1f} {p1[1]:.1f} "
            f"L {p2[0]:.1f} {p2[1]:.1f} "
            f"A {r_out} {r_out} 0 0 1 {p3[0]:.1f} {p3[1]:.1f} "
            f"L {p4[0]:.1f} {p4[1]:.1f} "
            f"A {r_in} {r_in} 0 0 0 {p1[0]:.1f} {p1[1]:.1f} Z"
        )

    blades = []
    for i, color in enumerate(p['colors']):
        start_inner = i * sweep - sweep / 2  # 首片居中朝上
        end_inner = start_inner + blade_a
        blades.append(f'    <path d="{blade_path(start_inner, end_inner)}" fill="{color}"/>')

    bx, by, bw, bh, br = p['body']
    lx, ly, lw, lh, lr = p['bump_l']
    rx, ry, rw, rh, rr = p['bump_r']
    sy1 = by + bh * p['strip_y1']
    sy2 = by + bh * p['strip_y2']

    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="{p['bg']}" rx="{p['bg_radius']}"/>

  <!-- 相机机身 -->
  <rect x="{bx}" y="{by}" width="{bw}" height="{bh}" rx="{br}" fill="#000000"/>
  <!-- 顶部凸起 -->
  <rect x="{lx}" y="{ly}" width="{lw}" height="{lh}" rx="{lr}" fill="#000000"/>
  <rect x="{rx}" y="{ry}" width="{rw}" height="{rh}" rx="{rr}" fill="#000000"/>

  <!-- 机身两侧白色横条（被镜头覆盖中间部分） -->
  <rect x="{bx}" y="{sy1}" width="{bw}" height="{p['strip_h']}" fill="{p['bg']}"/>
  <rect x="{bx}" y="{sy2}" width="{bw}" height="{p['strip_h']}" fill="{p['bg']}"/>

  <!-- 镜头外圈黑边 -->
  <circle cx="{cx}" cy="{cy}" r="{p['lens_outer_r']}" fill="none" stroke="#000000" stroke-width="{p['lens_stroke']}"/>
  <!-- 镜头白底 -->
  <circle cx="{cx}" cy="{cy}" r="{p['lens_inner_r']}" fill="{p['bg']}"/>

  <!-- 彩色光圈叶片 -->
  <g>
{chr(10).join(blades)}
  </g>

  <!-- 中心白色光圈开口 -->
  <circle cx="{cx}" cy="{cy}" r="{p['center_r']}" fill="{p['bg']}"/>
</svg>'''


def make_png(size):
    """生成指定尺寸的 PNG 图标，视觉与 SVG 一致。"""
    p = PARAMS
    scale = size / 512.0

    def s(v):
        if isinstance(v, tuple):
            return tuple(int(x * scale) for x in v)
        return int(v * scale)

    img = Image.new('RGBA', (size, size), hex_to_rgba(p['bg'], 0))
    draw = ImageDraw.Draw(img)

    # ===== 背景 =====
    draw.rounded_rectangle([0, 0, size - 1, size - 1],
                           radius=s(p['bg_radius']), fill=hex_to_rgba(p['bg']))

    # ===== 相机机身 =====
    bx, by, bw, bh, br = s(p['body'])
    lx, ly, lw, lh, lr = s(p['bump_l'])
    rx, ry, rw, rh, rr = s(p['bump_r'])
    boxes = [
        (bx, by, bx + bw, by + bh),
        (lx, ly, lx + lw, ly + lh),
        (rx, ry, rx + rw, ry + rh),
    ]
    radiuses = [s(p['body'][4]), s(p['bump_l'][4]), s(p['bump_r'][4])]

    # 轻微投影
    shadow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    for box, r in zip(boxes, radiuses):
        sdraw.rounded_rectangle(box, radius=r, fill=(0, 0, 0, 90))
    shadow = shadow.filter(ImageFilter.GaussianBlur(s(8)))
    img.alpha_composite(shadow)

    for box, r in zip(boxes, radiuses):
        draw.rounded_rectangle(box, radius=r, fill=(0, 0, 0, 255))

    # ===== 机身白色横条 =====
    sy1 = int(by + bh * p['strip_y1'])
    sy2 = int(by + bh * p['strip_y2'])
    sh = s(p['strip_h'])
    draw.rectangle([bx, sy1, bx + bw, sy1 + sh], fill=hex_to_rgba(p['bg']))
    draw.rectangle([bx, sy2, bx + bw, sy2 + sh], fill=hex_to_rgba(p['bg']))

    # ===== 镜头外圈 + 白底 =====
    cx, cy = s(p['lens_cx']), s(p['lens_cy'])
    outer_r = s(p['lens_outer_r'])
    inner_r = s(p['lens_inner_r'])
    draw.ellipse([cx - outer_r, cy - outer_r, cx + outer_r, cy + outer_r],
                 fill=(0, 0, 0, 255))
    draw.ellipse([cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r],
                 fill=hex_to_rgba(p['bg']))

    # ===== 彩色光圈叶片 =====
    n = p['blade_count']
    gap = p['blade_gap']
    twist = p['blade_twist']
    sweep = 360.0 / n
    blade_a = sweep - gap
    r_in = s(p['blade_r_in'])
    r_out = s(p['blade_r_out'])

    for i, color in enumerate(p['colors']):
        start_inner = i * sweep - sweep / 2
        end_inner = start_inner + blade_a
        start_outer = start_inner + twist
        end_outer = end_inner + twist

        pts = []
        steps = 32
        # 外缘（顺时针）
        for j in range(steps + 1):
            deg = start_outer + (end_outer - start_outer) * j / steps
            a = math.radians(deg - 90)
            pts.append((cx + r_out * math.cos(a), cy + r_out * math.sin(a)))
        # 内缘（逆时针返回）
        for j in range(steps, -1, -1):
            deg = start_inner + (end_inner - start_inner) * j / steps
            a = math.radians(deg - 90)
            pts.append((cx + r_in * math.cos(a), cy + r_in * math.sin(a)))
        draw.polygon(pts, fill=hex_to_rgba(color))

    # ===== 中心白色光圈开口 =====
    center_r = s(p['center_r'])
    draw.ellipse([cx - center_r, cy - center_r, cx + center_r, cy + center_r],
                 fill=hex_to_rgba(p['bg']))

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
    for sz in sizes:
        im = make_png(sz)
        im.save(os.path.join(ROOT, filenames[sz]), optimize=True)

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
    for sz in sizes:
        print('  -', filenames[sz])
    print('  - favicon.ico')
    print('  - favicon.svg')


if __name__ == '__main__':
    main()
