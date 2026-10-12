import SwiftUI
import WebKit
import UniformTypeIdentifiers

struct ContentView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> FMSViewController {
        FMSViewController()
    }

    func updateUIViewController(_ uiViewController: FMSViewController, context: Context) {}
}

final class FMSViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, UIDocumentPickerDelegate {
    private let url = URL(string: "https://transportseksyen.github.io/VMS/")!
    private var webView: WKWebView!
    private var uploadCompletion: (([URL]?) -> Void)?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        webView.load(URLRequest(url: url))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let destination = navigationAction.request.url,
              let host = destination.host else {
            decisionHandler(.cancel)
            return
        }

        let isSecureHTTPS = destination.scheme?.lowercased() == "https"
        let path = destination.path
        let isFMSWebOrigin = host == "transportseksyen.github.io" &&
            (path == "/VMS" || path.hasPrefix("/VMS/"))
        let isFMSAPIOrigin = host == "onxxgdbnonctwiykwdxo.supabase.co"

        if isSecureHTTPS && (isFMSWebOrigin || isFMSAPIOrigin) {
            decisionHandler(.allow)
        } else {
            // External destinations open outside the authenticated FMS WebView.
            UIApplication.shared.open(destination)
            decisionHandler(.cancel)
        }
    }

    @available(iOS 18.4, *)
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        uploadCompletion = completionHandler

        let picker = UIDocumentPickerViewController(
            forOpeningContentTypes: [.item],
            asCopy: true
        )
        picker.delegate = self
        picker.allowsMultipleSelection = false
        present(picker, animated: true)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController,
                        didPickDocumentsAt urls: [URL]) {
        uploadCompletion?(urls)
        uploadCompletion = nil
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        uploadCompletion?(nil)
        uploadCompletion = nil
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
    }
}
