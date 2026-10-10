// Draws the MacStream icon into an .iconset folder: black rounded tile, white play triangle.
// Run with:  swift make-icon.swift <path/to/MacStream.iconset>
// The system masks the square PNGs into the rounded app shape, so the tile is drawn full-bleed
// with its own soft rounding for contexts that show the raw artwork.
import AppKit

func drawTile(size: CGFloat) -> NSImage {
    let img = NSImage(size: NSSize(width: size, height: size))
    img.lockFocus()
    defer { img.unlockFocus() }

    let rect = NSRect(x: 0, y: 0, width: size, height: size)

    // Near-black vertical gradient — reads as "true black" but keeps a faint edge definition
    // so the icon does not vanish into a dark Dock.
    if let grad = NSGradient(starting: NSColor(white: 0.13, alpha: 1),
                             ending: NSColor(white: 0.02, alpha: 1)) {
        grad.draw(in: rect, angle: -90)
    }

    // Hairline border, very low alpha.
    let border = NSBezierPath(roundedRect: rect.insetBy(dx: size * 0.012, dy: size * 0.012),
                              xRadius: size * 0.21, yRadius: size * 0.21)
    NSColor(white: 1, alpha: 0.12).setStroke()
    border.lineWidth = max(1, size * 0.018)
    border.stroke()

    // Play triangle: rounded-tip chevron feel via a plain triangle (matches "play button").
    let h = size * 0.40
    let w = h * 0.88
    let cx = size * 0.535      // optical center: slightly right of geometric center
    let cy = size * 0.5
    let tri = NSBezierPath()
    tri.move(to: NSPoint(x: cx - w / 2, y: cy + h / 2))
    tri.line(to: NSPoint(x: cx - w / 2, y: cy - h / 2))
    tri.line(to: NSPoint(x: cx + w / 2, y: cy))
    tri.close()
    NSColor.white.setFill()
    tri.fill()

    return img
}

func png(_ size: CGFloat) -> Data? {
    let img = drawTile(size: size)
    guard let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff) else { return nil }
    return rep.representation(using: .png, properties: [:])
}

guard CommandLine.arguments.count == 2 else {
    fputs("usage: make-icon.swift <iconset dir>\n", stderr)
    exit(1)
}
let dir = CommandLine.arguments[1]
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

// iconutil naming: @2x files are the doubled raster.
let sizes: [(String, CGFloat)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

for (name, px) in sizes {
    guard let data = png(px) else {
        fputs("failed to draw \(name)\n", stderr)
        exit(1)
    }
    try data.write(to: URL(fileURLWithPath: dir + "/" + name))
}
print("iconset written to \(dir)")
