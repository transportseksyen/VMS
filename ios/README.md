# Sarawak FMS iOS App

This is a native iOS WKWebView shell for the Sarawak Fleet Management System.

## Build
Open the Xcode project generated from the repository in Xcode on macOS, set your Apple Developer Team under Signing & Capabilities, then build for iPhone.

The app loads the published FMS web system:
https://transportseksyen.github.io/VMS/

The WebView is limited to the FMS GitHub Pages path and the project's Supabase API origin. Other web links open outside the app's authenticated WebView. No Supabase secret keys are embedded in the iOS app.

The default CI workflow produces an unsigned app archive. To install on a real iPhone, sign it with the correct Apple Developer certificate and provisioning profile, or distribute through TestFlight.
