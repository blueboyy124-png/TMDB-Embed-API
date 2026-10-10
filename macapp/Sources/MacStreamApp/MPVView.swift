import SwiftUI
import AppKit
import OpenGL.GL
import OpenGL.GL3
import CMPV

// MARK: - OpenGL entry points for mpv's renderer

/// mpv resolves every GL function through this callback instead of linking GL
/// itself. RTLD_DEFAULT (-2) walks the flat namespace of the OpenGL framework,
/// which is the same set of symbols mpv's own macOS frontend resolves through
/// CFBundle. Returns nil for anything the framework does not export, which mpv
/// treats as "function unavailable" and handles.
private func mpvGetProcAddress(_ ctx: UnsafeMutableRawPointer?, _ name: UnsafePointer<CChar>?) -> UnsafeMutableRawPointer? {
    guard let name else { return nil }
    return String(cString: name).withCString { dlsym(UnsafeMutableRawPointer(bitPattern: -2), $0) }
}

/// Called from mpv's core thread whenever there is a new frame to draw.
/// All it may do is ask the layer to redraw -- never call mpv itself.
private let mpvUpdateCallback: mpv_render_update_fn = { ctx in
    guard let ctx else { return }
    Unmanaged<MPVController>.fromOpaque(ctx).takeUnretainedValue().requestDisplay()
}

// MARK: - Player

/// Owns one mpv core and the GL context it renders into. Held outside the view
/// struct so it survives view updates.
///
/// Two rules shape this class:
///
/// 1. **Never block the main thread.** Every control call runs on a private
///    serial queue, and every mpv call is asynchronous. A stream that wedges
///    (70GB unseekable MKVs, expired signed links) blocks mpv's core, and a
///    synchronous mpv call from main parks the whole UI behind it -- that was
///    the beachball.
/// 2. **mpv must never open a window of its own.** On macOS `--wid` is ignored
///    (only X11/win32/Android read it), so binding a window handle silently
///    does nothing and mpv creates a second window. The render API is the only
///    inline path: `vo=libmpv` + `mpv_render_context` painting into our own
///    CAOpenGLLayer. That is what makes "plays in the app" and "decodes MKV/4K"
///    the same statement.
final class MPVController {
    /// The controller a freshly attached view should reuse instead of starting a
    /// second mpv (SwiftUI can rebuild the view while one is already playing).
    static weak var current: MPVController?

    static func log(_ s: String) {
        fputs("[mpv] \(s) (main=\(Thread.isMainThread))\n", stderr)
    }

    private(set) var handle: OpaquePointer?
    private(set) var renderContext: OpaquePointer?

    /// mpv's render context is bound to one GL context for life, so the layer
    /// has to draw into exactly this one.
    let cglContext: CGLContextObj
    let cglPixelFormat: CGLPixelFormatObj
    let bufferDepth: GLint

    /// The layer currently showing this player. Weak: the view owns it, and a
    /// controller outliving its view must not keep a dead layer alive.
    weak var layer: MPVLayer?

    private let cmdQueue = DispatchQueue(label: "mpv-control")
    /// mpv allows only one mpv_render_* call at a time; this serialises the
    /// draw path (main) against teardown (cmdQueue).
    private let renderLock = NSLock()
    private var loggedRenderError = false

    var isAlive: Bool { handle != nil }

    // MARK: creation

    private init(cglContext: CGLContextObj, cglPixelFormat: CGLPixelFormatObj) {
        self.cglContext = cglContext
        self.cglPixelFormat = cglPixelFormat
        self.bufferDepth = 8
    }

    /// Builds the GL context, the mpv core and the render context. Must run on
    /// the thread that will draw (main), with GL available.
    static func make() -> MPVController? {
        // 3.2 core profile first (mpv's own choice), legacy as the fallback for
        // machines where no core-profile renderer is offered.
        var attrs: [CGLPixelFormatAttribute] = [
            kCGLPFAOpenGLProfile, _CGLPixelFormatAttribute(rawValue: kCGLOGLPVersion_3_2_Core.rawValue),
            kCGLPFAAccelerated, kCGLPFADoubleBuffer, _CGLPixelFormatAttribute(rawValue: 0)
        ]
        var pix: CGLPixelFormatObj? = nil
        var npix: GLint = 0
        var err = CGLChoosePixelFormat(attrs, &pix, &npix)
        if err.rawValue != 0 || pix == nil {
            attrs = [kCGLPFAAccelerated, kCGLPFADoubleBuffer, _CGLPixelFormatAttribute(rawValue: 0)]
            err = CGLChoosePixelFormat(attrs, &pix, &npix)
            MPVController.log("pixel format fell back to legacy (core profile err \(err.rawValue))")
        }
        guard err.rawValue == 0, let pf = pix else {
            MPVController.log("CGLChoosePixelFormat failed: \(err.rawValue)")
            return nil
        }
        var ctx: CGLContextObj? = nil
        guard CGLCreateContext(pf, nil, &ctx) == kCGLNoError, let cgl = ctx else {
            MPVController.log("CGLCreateContext failed")
            CGLReleasePixelFormat(pf)
            return nil
        }
        CGLSetCurrentContext(cgl)

        let controller = MPVController(cglContext: cgl, cglPixelFormat: pf)
        guard controller.startMPV() else {
            CGLSetCurrentContext(nil)
            CGLReleaseContext(cgl)
            CGLReleasePixelFormat(pf)
            return nil
        }
        return controller
    }

    private func startMPV() -> Bool {
        guard let h = mpv_create() else { MPVController.log("mpv_create FAILED"); return false }
        handle = h

        // NOTE: no `wid` option here, deliberately. macOS mpv ignores it and
        // would open its own window; vo=libmpv + the render context is the
        // inline path.
        mpv_set_option_string(h, "vo", "libmpv")
        mpv_set_option_string(h, "keep-open", "yes")     // hold the last frame at the end
        mpv_set_option_string(h, "idle", "yes")
        mpv_set_option_string(h, "input-default-bindings", "no")
        mpv_set_option_string(h, "osc", "no")            // the transport bar below is ours
        mpv_set_option_string(h, "hwdec", "auto-safe")   // VideoToolbox, zero-copy into our GL context
        // Debug/status socket: a running player can be interrogated (playback-time,
        // hwdec-current, paused-for-cache) without touching the app.
        mpv_set_option_string(h, "input-ipc-server", "/tmp/mpvsock")
        // Cap buffering: a 70GB unseekable file otherwise eats gigabytes while
        // mpv retries seeks that restart the download from zero.
        mpv_set_option_string(h, "demuxer-max-bytes", "150MiB")
        mpv_set_option_string(h, "demuxer-max-back-bytes", "50MiB")

        // The render context has to exist before the first loadfile, or mpv
        // falls back to a VO that creates its own window.
        var advanced: Int32 = 1
        let api = UnsafeMutableRawPointer(mutating: (MPV_RENDER_API_TYPE_OPENGL as NSString).utf8String)
        var initParams = mpv_opengl_init_params(get_proc_address: mpvGetProcAddress, get_proc_address_ctx: nil)
        var rc: OpaquePointer? = nil
        var created: Int32 = -1
        withUnsafeMutablePointer(to: &initParams) { ip in
            withUnsafeMutablePointer(to: &advanced) { ap in
                var params: [mpv_render_param] = [
                    mpv_render_param(type: MPV_RENDER_PARAM_API_TYPE, data: api),
                    mpv_render_param(type: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, data: ip),
                    mpv_render_param(type: MPV_RENDER_PARAM_ADVANCED_CONTROL, data: ap),
                    mpv_render_param()
                ]
                created = mpv_render_context_create(&rc, h, &params)
            }
        }
        guard created == 0, let context = rc else {
            MPVController.log("mpv_render_context_create failed: \(created) \(String(cString: mpv_error_string(created)))")
            mpv_terminate_destroy(h)
            handle = nil
            return false
        }
        renderContext = context
        mpv_render_context_set_update_callback(context, mpvUpdateCallback,
                                               Unmanaged.passUnretained(self).toOpaque())

        if mpv_initialize(h) < 0 {
            MPVController.log("mpv_initialize FAILED")
            teardownNow(rc: context, handle: h)
            handle = nil
            renderContext = nil
            return false
        }
        MPVController.log("ready: vo=libmpv, hwdec=auto-safe, render context live")
        return true
    }

    // MARK: display path (called on main from the layer)

    /// mpv's core thread asks for a redraw. Nothing but a hop to main.
    func requestDisplay() {
        DispatchQueue.main.async { [weak self] in
            guard let layer = self?.layer else { return }
            // setNeedsDisplay covers the case where display() alone would be
            // ignored; display() draws now so the frame is not a runloop late.
            layer.setNeedsDisplay()
            layer.needsFlip = true
            layer.display()
        }
    }

    /// Called from canDraw: consumes mpv's pending update flag. With
    /// MPV_RENDER_PARAM_ADVANCED_CONTROL this must happen after every update
    /// callback or mpv's core stalls, so it runs whether or not a draw follows.
    func consumeUpdateFrame() -> Bool {
        renderLock.lock()
        defer { renderLock.unlock() }
        guard let rc = renderContext, isAlive else { return false }
        return mpv_render_context_update(rc) & UInt64(MPV_RENDER_UPDATE_FRAME.rawValue) != 0
    }

    /// Paints the current frame into the given framebuffer. `probe` asks for the
    /// centre-pixel readback used by the diagnostics -- deliberately not every
    /// frame, because glReadPixels is a full pipeline stall.
    func renderFrame(width: Int, height: Int, depth: GLint, probe: Bool) -> Int {
        renderLock.lock()
        defer { renderLock.unlock() }
        guard let rc = renderContext, isAlive else { return 0 }

        // CAOpenGLLayer owns the draw framebuffer; it is 0 when the context is
        // bound straight to the layer's drawable.
        var fbo: GLint = 0
        glGetIntegerv(GLenum(GL_FRAMEBUFFER_BINDING), &fbo)
        var target = mpv_opengl_fbo(fbo: fbo, w: Int32(width), h: Int32(height), internal_format: 0)
        var flip: Int32 = 1      // verified: FLIP_Y=1 puts the image top at the layer top
        var ditherDepth: Int32 = depth
        var block: Int32 = 0     // never wait: mpv must not hold the main thread for timing

        let status: Int32 = withUnsafeMutablePointer(to: &target) { t in
            withUnsafeMutablePointer(to: &flip) { f in
                withUnsafeMutablePointer(to: &ditherDepth) { d in
                    withUnsafeMutablePointer(to: &block) { b in
                        var params: [mpv_render_param] = [
                            mpv_render_param(type: MPV_RENDER_PARAM_OPENGL_FBO, data: t),
                            mpv_render_param(type: MPV_RENDER_PARAM_FLIP_Y, data: f),
                            mpv_render_param(type: MPV_RENDER_PARAM_DEPTH, data: d),
                            mpv_render_param(type: MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, data: b),
                            mpv_render_param()
                        ]
                        return mpv_render_context_render(rc, &params)
                    }
                }
            }
        }
        if status < 0 && !loggedRenderError {
            loggedRenderError = true
            MPVController.log("render failed: \(String(cString: mpv_error_string(status)))")
        }
        return probe ? centrePixelSum(fbo: fbo, width: width, height: height) : 0
    }

    /// One pixel block from the middle of the frame, so a run can prove it is
    /// painting rather than showing a black rectangle.
    ///
    /// The framebuffer has to be re-bound first: mpv resets GL state to the
    /// standard defaults when it returns, so the binding is 0 by the time we
    /// read -- and 0 is not necessarily the surface mpv just drew into (with a
    /// double-buffered layer it can be a different buffer entirely).
    private func centrePixelSum(fbo: GLint, width: Int, height: Int) -> Int {
        guard width > 16, height > 16 else { return 0 }
        glBindFramebuffer(GLenum(GL_FRAMEBUFFER), GLuint(max(0, fbo)))
        var px = [UInt8](repeating: 0, count: 4)
        px.withUnsafeMutableBytes { buf in
            glReadPixels(GLint(width / 2), GLint(height / 2), 1, 1,
                         GLenum(GL_RGBA), GLenum(GL_UNSIGNED_BYTE), buf.baseAddress)
        }
        return px.reduce(0) { $0 + Int($1) }
    }

    // MARK: control (always off-main)

    func command(_ s: String) {
        cmdQueue.async { [weak self] in
            guard let h = self?.handle else { return }
            mpv_command_string(h, s)
        }
    }

    func setPaused(_ p: Bool) {
        cmdQueue.async { [weak self] in
            guard let h = self?.handle else { return }
            mpv_set_property_string(h, "pause", p ? "yes" : "no")
        }
    }

    func readPosition(_ cb: @escaping (Double, Double, Bool) -> Void) {
        cmdQueue.async { [weak self] in
            guard let h = self?.handle else { return }
            var t: Double = 0, d: Double = 0
            mpv_get_property(h, "time-pos", MPV_FORMAT_DOUBLE, &t)
            mpv_get_property(h, "duration", MPV_FORMAT_DOUBLE, &d)
            // core-idle: mpv is waiting (on the network cache) rather than decoding. Paused
            // is idle too — the caller combines this with its own isPlaying to tell them apart.
            var idle: Int32 = 0
            mpv_get_property(h, "core-idle", MPV_FORMAT_FLAG, &idle)
            let tt = t, dd = d, ii = idle != 0
            DispatchQueue.main.async { cb(tt, dd, ii) }
        }
    }

    func seek(to seconds: Double) {
        cmdQueue.async { [weak self] in
            guard let h = self?.handle else { return }
            var v = seconds
            mpv_set_property(h, "time-pos", MPV_FORMAT_DOUBLE, &v)
        }
    }

    func seekBy(_ seconds: Double) { command("seek \(seconds)") }

    /// Loads a stream, optionally at a position. `start=` is mpv's per-file option (mpv ≥0.38):
    /// the first frame lands at `startAt` instead of flashing 0:00 and then jumping — this is
    /// how Continue Watching and mid-stream row switches keep their place.
    func play(_ u: String, startAt: Double? = nil) {
        var cmd = "loadfile \(u.replacingOccurrences(of: "'", with: "\\'")) replace"
        if let s = startAt, s.isFinite, s > 1 { cmd += " start=\(Int(s))" }
        MPVController.log("loadfile \(u.prefix(80))\(startAt.map { " @\(Int($0))s" } ?? "")")
        command(cmd)
    }

    // MARK: teardown

    /// Stops playback and destroys mpv. Safe to call from main: the parts that
    /// can wait (render context free, stream teardown) run on cmdQueue, because
    /// waiting on mpv from main is exactly how the app used to beachball.
    /// `completion` (optional) fires on main once the mpv handle is truly gone —
    /// callers that immediately rebuild use it to not overlap teardown.
    func shutdown(_ completion: (() -> Void)? = nil) {
        guard let h = handle else {
            if let completion { DispatchQueue.main.async(execute: completion) }
            return
        }
        let rc = renderContext
        handle = nil
        renderContext = nil
        layer = nil
        if let rc {
            // Before anything is torn down: no more update callbacks into a
            // controller that is going away.
            renderLock.lock()
            mpv_render_context_set_update_callback(rc, nil, nil)
            renderLock.unlock()
        }
        let cgl = cglContext, pf = cglPixelFormat
        if MPVController.current === self { MPVController.current = nil }
        MPVController.log("shutdown requested")
        cmdQueue.async {
            self.teardownNow(rc: rc, handle: h)
            CGLReleaseContext(cgl)
            CGLReleasePixelFormat(pf)
            MPVController.log("shutdown complete")
            if let completion { DispatchQueue.main.async(execute: completion) }
        }
    }

    /// Frees the render context (which needs the GL context current) and then
    /// the core. mpv requires the render context to die first.
    private func teardownNow(rc: OpaquePointer?, handle h: OpaquePointer) {
        if let rc {
            CGLLockContext(cglContext)
            CGLSetCurrentContext(cglContext)
            renderLock.lock()
            mpv_render_context_free(rc)
            renderLock.unlock()
            CGLSetCurrentContext(nil)
            CGLUnlockContext(cglContext)
        }
        mpv_terminate_destroy(h)
    }

    deinit {
        // Normally shutdown() has already run. This is the belt-and-braces path
        // for a controller dropped without it -- locals only, because capturing
        // self in an async block during deinit would resurrect the object.
        guard let h = handle else { return }
        let rc = renderContext
        if let rc { mpv_render_context_set_update_callback(rc, nil, nil) }
        let cgl = cglContext, pf = cglPixelFormat
        DispatchQueue.global(qos: .userInitiated).async {
            if let rc {
                CGLLockContext(cgl)
                CGLSetCurrentContext(cgl)
                mpv_render_context_free(rc)
                CGLSetCurrentContext(nil)
                CGLUnlockContext(cgl)
            }
            mpv_terminate_destroy(h)
            CGLReleaseContext(cgl)
            CGLReleasePixelFormat(pf)
        }
    }
}

// MARK: - Layer

/// Paints mpv into the app window. A plain CALayer cannot: no system framework
/// decodes Matroska, so the pixels come from mpv's own renderer.
final class MPVLayer: CAOpenGLLayer {
    weak var controller: MPVController?
    let cglContext: CGLContextObj
    let cglPixelFormat: CGLPixelFormatObj
    let bufferDepth: GLint

    var needsFlip = false
    private var lastSize: (Int, Int) = (0, 0)
    private var loggedFirstFrame = false
    private var drawPasses = 0

    init(controller: MPVController, depth: GLint = 8) {
        self.controller = controller
        self.cglContext = controller.cglContext
        self.cglPixelFormat = controller.cglPixelFormat
        self.bufferDepth = depth
        super.init()
        backgroundColor = NSColor.black.cgColor
        isAsynchronous = false     // redraw when mpv asks, on main (mpv's own model)
    }

    override init(layer: Any) {
        // CALayer copies layers when they move between windows/screens; share
        // the controller and GL context rather than inventing a new player.
        guard let old = layer as? MPVLayer else {
            fatalError("MPVLayer.init(layer:) passed \(type(of: layer))")
        }
        controller = old.controller
        cglContext = old.cglContext
        cglPixelFormat = old.cglPixelFormat
        bufferDepth = old.bufferDepth
        lastSize = old.lastSize
        super.init()
        backgroundColor = NSColor.black.cgColor
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    // Our GL objects are owned by the controller; if the layer released them
    // when it was deallocated, mpv would render into freed memory.
    override func copyCGLPixelFormat(forDisplayMask mask: UInt32) -> CGLPixelFormatObj { cglPixelFormat }
    override func copyCGLContext(forPixelFormat pf: CGLPixelFormatObj) -> CGLContextObj { cglContext }
    override func releaseCGLPixelFormat(_ pf: CGLPixelFormatObj) {}
    override func releaseCGLContext(_ ctx: CGLContextObj) {}

    override func canDraw(inCGLContext ctx: CGLContextObj,
                          pixelFormat pf: CGLPixelFormatObj,
                          forLayerTime t: CFTimeInterval,
                          displayTime ts: UnsafePointer<CVTimeStamp>?) -> Bool {
        guard let c = controller, c.isAlive else { return false }
        // Consume the update flag unconditionally: mpv requires it after every
        // update callback, even when this particular pass is a resize redraw.
        let newFrame = c.consumeUpdateFrame()
        let size = drawableSize()
        return newFrame || size != lastSize
    }

    override func draw(inCGLContext ctx: CGLContextObj,
                       pixelFormat pf: CGLPixelFormatObj,
                       forLayerTime t: CFTimeInterval,
                       displayTime ts: UnsafePointer<CVTimeStamp>?) {
        needsFlip = false
        let size = drawableSize()
        lastSize = size
        drawPasses += 1
        // Probe the framebuffer only at start-up and then once every ~5s of
        // video: a readback per frame would cost a GPU stall each frame.
        let probe = drawPasses <= 3 || drawPasses % 120 == 0
        var pixelSum = 0
        if let c = controller, c.isAlive {
            pixelSum = c.renderFrame(width: size.0, height: size.1, depth: bufferDepth, probe: probe)
        } else {
            glClearColor(0, 0, 0, 1)
            glClear(GLbitfield(GL_COLOR_BUFFER_BIT))
        }
        // Only probes report anything: outside a probe pixelSum is 0 by design,
        // which would look like a false "black" log.
        if probe {
            // 255 == alpha only (opaque black); a real picture adds RGB on top.
            let hasPicture = pixelSum > 1000
            MPVController.log("draw #\(drawPasses) \(size.0)x\(size.1) centre pixel sum=\(pixelSum) (\(hasPicture ? "picture" : "black"))")
            if !loggedFirstFrame, hasPicture {
                loggedFirstFrame = true
                MPVController.log("inline picture confirmed: draw #\(drawPasses), centre pixel sum \(pixelSum)")
            }
        }
        // Documented way to flush a CAOpenGLLayer's context after rendering.
        super.draw(inCGLContext: ctx, pixelFormat: pf, forLayerTime: t, displayTime: ts)
    }

    /// The drawable's size in PIXELS: this is what mpv must render at, or the
    /// layer scales a mis-sized frame. The CGL surface size is authoritative
    /// while drawing; bounds × contentsScale is the fallback.
    private func drawableSize() -> (Int, Int) {
        var sz: [GLint] = [0, 0]
        if CGLGetParameter(cglContext, kCGLCPSurfaceBackingSize, &sz) == kCGLNoError, sz[0] > 0, sz[1] > 0 {
            return (Int(sz[0]), Int(sz[1]))
        }
        let s = contentsScale
        return (max(1, Int(bounds.width * s)), max(1, Int(bounds.height * s)))
    }
}

// MARK: - View

/// A plain NSView whose backing layer is the mpv layer. No drawing code here;
/// mpv paints.
final class VideoNSView: NSView {
    weak var mpvLayer: MPVLayer?
    override var acceptsFirstResponder: Bool { true }
    // Clicking the video takes key focus, so the keyboard shortcuts (space, seek, row
    // switching) have an unambiguous target. Without this the first responder is whatever
    // list or button was touched last, and those controls correctly keep their own keys.
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        super.mouseDown(with: event)
    }
}

/// mpv rendering directly inside a SwiftUI view.
///
/// Why not AVPlayer: no Apple framework decodes Matroska, and every 4K stream
/// this API returns is an MKV. Spawning mpv as a subprocess works but opens a
/// second window. Binding mpv's renderer to this view's layer is what makes
/// "always inline" and "plays 4K" the same statement.
struct MPVView: NSViewRepresentable {
    let url: String?
    /// Position to start at when `url` changes (see MPVController.play(_:startAt:)).
    var startAt: Double? = nil
    @Binding var isPlaying: Bool
    var onReady: (MPVController) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var controller: MPVController?
        var lastURL: String?
        /// Last pause state sent to mpv. updateNSView runs on main on every
        /// redraw (including each position tick), so sending pause unconditionally
        /// would mean an mpv call 2x/sec for no reason.
        var lastPaused: Bool?
    }

    func makeNSView(context: Context) -> NSView {
        let v = VideoNSView()
        // Create everything off the first frame: the view has no window yet, and
        // mpv creation must not sit on the main thread longer than necessary.
        DispatchQueue.main.async { [weak v] in
            guard let view = v else { return }
            self.attach(to: view, coordinator: context.coordinator)
        }
        return v
    }

    private func attach(to view: VideoNSView, coordinator: Coordinator, attempt: Int = 0) {
        if attempt % 10 == 0 {
            var chain: [String] = []
            var v: NSView? = view
            while let cur = v, chain.count < 12 {
                chain.append(String(describing: type(of: cur)))
                v = cur.superview
            }
            MPVController.log("attach attempt \(attempt): window=\(view.window != nil) chain=[\(chain.joined(separator: " > "))]")
        }
        guard view.window != nil else {
            // Not in a window on the first pass. Retry rather than give up:
            // without a controller nothing -- not even switching streams -- can
            // ever work afterwards.
            if attempt < 30 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak view] in
                    guard let view else { return }
                    self.attach(to: view, coordinator: coordinator, attempt: attempt + 1)
                }
            } else {
                MPVController.log("attach gave up: view never got a window")
            }
            return
        }

        // Reuse a live controller if SwiftUI rebuilt this view while a stream
        // was playing -- two mpv cores would mean two audio outputs.
        var controller = coordinator.controller
        if controller == nil {
            if let existing = MPVController.current, existing.isAlive {
                controller = existing
                MPVController.log("reusing the running player for a rebuilt view")
            } else {
                controller = MPVController.make()
            }
        }
        guard let c = controller else {
            MPVController.log("could not create the embedded player")
            return
        }
        MPVController.current = c
        coordinator.controller = c

        let layer = MPVLayer(controller: c)
        view.wantsLayer = true
        view.layer = layer
        view.mpvLayer = layer
        view.layerContentsRedrawPolicy = .never
        layer.contentsScale = view.window?.backingScaleFactor ?? 1
        c.layer = layer

        coordinator.lastURL = url
        coordinator.lastPaused = nil
        if let u = url { c.play(u, startAt: startAt) }
        MPVController.log("attached to view")
        onReady(c)
    }

    func updateNSView(_ view: NSView, context: Context) {
        guard let v = view as? VideoNSView else { return }
        // AppKit can swap the backing layer (screen change, SwiftUI re-hosting);
        // putting ours back keeps the picture from disappearing.
        if let l = v.mpvLayer, v.layer !== l { v.layer = l }

        // lastURL lives on the COORDINATOR so a redraw never restarts playback
        // from zero; it is compared before anything is sent to mpv.
        guard let c = context.coordinator.controller else { return }
        if context.coordinator.lastURL != url {
            context.coordinator.lastURL = url
            context.coordinator.lastPaused = nil
            if let u = url { c.play(u, startAt: startAt); isPlaying = true } else { c.command("stop") }
        }
        // Sent only when it CHANGES, and asynchronously through the controller's
        // queue -- the deadlock the app used to hit was main parked inside mpv
        // while mpv waited on a wedged stream.
        let wantPaused = !isPlaying
        if context.coordinator.lastPaused != wantPaused {
            context.coordinator.lastPaused = wantPaused
            c.setPaused(wantPaused)
        }
    }
}
