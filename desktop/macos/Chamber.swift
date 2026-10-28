import AppKit
import WebKit
import UniformTypeIdentifiers

// The remote page has no native bridge, filesystem access or relaxed TLS.
final class ChamberApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var shield: NSView!
    private var failure: NSView?
    private var titleObservation: NSKeyValueObservation?
    private let home = URL(string: "https://ai.shui.click/")!
    private let smoke = CommandLine.arguments.contains("--self-test")

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        makeMenu()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.applicationNameForUserAgent = "ChamberDesktop/1.0"
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 800), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Chamber"
        window.minSize = NSSize(width: 640, height: 480)
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.setFrameAutosaveName("ChamberMainWindow")
        window.contentView = webView
        shield = NSView(frame: webView.bounds)
        shield.wantsLayer = true
        shield.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        shield.autoresizingMask = [.width, .height]
        shield.isHidden = true
        webView.addSubview(shield)
        titleObservation = webView.observe(\.title, options: [.new]) { [weak self] _, _ in
            guard let self else { return }
            self.window.title = NSApp.isActive ? (self.webView.title ?? "Chamber") : "Chamber"
        }
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if smoke {
            webView.loadHTMLString("<meta name='viewport' content='width=device-width'><h1>Chamber</h1><p>本机窗口与 WebKit 已就绪</p>", baseURL: nil)
        } else {
            webView.load(URLRequest(url: home))
        }
    }
    private func isHome(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == home.host && (url.port == nil || url.port == 443) && url.user == nil && url.password == nil
    }
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if smoke && url.absoluteString == "about:blank" { decisionHandler(.allow); return }
        if action.shouldPerformDownload && (isHome(url) || url.scheme == "blob") { decisionHandler(.download); return }
        if action.navigationType == .linkActivated && action.targetFrame == nil && ["https", "http"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        if isHome(url) {
            if action.targetFrame == nil { webView.load(action.request); decisionHandler(.cancel) }
            else { decisionHandler(.allow) }
        } else {
            // Only deliberate links may leave the app; redirects cannot launch programs.
            if action.navigationType == .linkActivated && ["https", "http"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.protocol == "https" && origin.host == home.host && (origin.port == 0 || origin.port == 443) ? .prompt : .deny)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        failure?.removeFromSuperview(); failure = nil
        if smoke {
            webView.evaluateJavaScript("({secure:window.isSecureContext,title:document.querySelector('h1').textContent})") { result, error in
                print("CHAMBER_MAC_SELF_TEST \(error == nil && (result as? [String:Any])?["title"] as? String == "Chamber" ? "PASS" : "FAIL")")
                NSApp.terminate(nil)
            }
        }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { showFailure(error) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { showFailure(error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { reloadPage() }
    private func showFailure(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        failure?.removeFromSuperview()
        let panel = NSView(frame: webView.bounds)
        panel.autoresizingMask = [.width, .height]
        panel.wantsLayer = true; panel.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        let label = NSTextField(wrappingLabelWithString: "暂时无法连接 Chamber，请检查网络后重试。")
        label.alignment = .center
        let button = NSButton(title: "重新连接", target: self, action: #selector(reloadPage))
        let stack = NSStackView(views: [label, button]); stack.orientation = .vertical; stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false; panel.addSubview(stack)
        NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: panel.centerXAnchor), stack.centerYAnchor.constraint(equalTo: panel.centerYAnchor), stack.widthAnchor.constraint(lessThanOrEqualToConstant: 400)])
        webView.addSubview(panel, positioned: .below, relativeTo: shield); failure = panel
    }
    func applicationWillResignActive(_ notification: Notification) { shield.isHidden = false; window.title = "Chamber" }
    func applicationDidBecomeActive(_ notification: Notification) { shield?.isHidden = true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { window.makeKeyAndOrderFront(nil); return true }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    @objc private func reloadPage() { if let url = webView.url, isHome(url) { webView.reload() } else { webView.load(URLRequest(url: home)) } }
    @objc private func showWindow() { window.makeKeyAndOrderFront(nil) }
    @objc private func openRoomLink() {
        let alert = NSAlert()
        alert.messageText = "打开密室链接"
        alert.informativeText = "粘贴你的 Chamber 邀请或设备加入链接。链接仅在本机交给正式站点处理。"
        alert.addButton(withTitle: "打开"); alert.addButton(withTitle: "取消")
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 420, height: 26))
        field.placeholderString = "https://ai.shui.click/…"
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { [weak self] response in
            let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            field.stringValue = ""
            guard response == .alertFirstButtonReturn, let self else { return }
            guard let url = URL(string: text), self.isHome(url) else {
                let error = NSAlert(); error.messageText = "仅支持 Chamber 正式站点的 HTTPS 链接"
                error.beginSheetModal(for: self.window); return
            }
            self.webView.load(URLRequest(url: url))
        }
    }
    private func makeMenu() {
        let menu = NSMenu(), appItem = NSMenuItem(), appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Chamber", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 Chamber", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "退出 Chamber", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; menu.addItem(appItem)
        let fileItem = NSMenuItem(), file = NSMenu(title: "文件")
        file.addItem(withTitle: "打开密室链接…", action: #selector(openRoomLink), keyEquivalent: "o").target = self
        fileItem.submenu = file; menu.addItem(fileItem)
        let editItem = NSMenuItem(), edit = NSMenu(title: "编辑")
        for (name, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: name, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit; menu.addItem(editItem)
        let windowItem = NSMenuItem(), windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "打开 Chamber", action: #selector(showWindow), keyEquivalent: "0").target = self
        windowMenu.addItem(withTitle: "重新连接", action: #selector(reloadPage), keyEquivalent: "r").target = self
        windowItem.submenu = windowMenu; menu.addItem(windowItem); NSApp.mainMenu = menu
    }
}
let application = NSApplication.shared
let delegate = ChamberApp()
application.delegate = delegate
application.run()
