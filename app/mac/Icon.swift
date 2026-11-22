// The app's r3 wordmark, matching the neon title in the bundled web UI.
import Cocoa
let directory = CommandLine.arguments[1]
try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let image = NSImage(size: NSSize(width: pixels, height: pixels))
        image.lockFocus()
        let p = CGFloat(pixels)
        NSColor(calibratedRed: 0.025, green: 0.015, blue: 0.065, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: p * 0.035, y: p * 0.035, width: p * 0.93, height: p * 0.93), xRadius: p * 0.2, yRadius: p * 0.2).fill()
        let text = "r3" as NSString
        let font = NSFont.monospacedSystemFont(ofSize: p * 0.64, weight: .heavy)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(calibratedRed: 1, green: 0.17, blue: 0.84, alpha: 1)]
        let measure = text.size(withAttributes: attributes)
        let origin = NSPoint(x: (p - measure.width) / 2, y: (p - measure.height) / 2 + p * 0.02)
        let shadow = NSShadow(); shadow.shadowColor = NSColor.magenta.withAlphaComponent(0.65); shadow.shadowBlurRadius = p * 0.06; shadow.set()
        text.draw(at: origin, withAttributes: attributes)
        image.unlockFocus()
        let bitmap = NSBitmapImageRep(data: image.tiffRepresentation!)!
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(directory)/icon_\(size)x\(size)\(scale == 2 ? "@2x" : "").png"))
    }
}
