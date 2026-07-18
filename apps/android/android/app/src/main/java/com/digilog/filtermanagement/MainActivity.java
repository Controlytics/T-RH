package com.digilog.filtermanagement;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.Bridge;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register the RFID plugin BEFORE super.onCreate so the bridge picks it up
        registerPlugin(RfidPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onStart() {
        super.onStart();
        Bridge bridge = getBridge();
        if (bridge != null) {
            WebView webView = bridge.getWebView();
            if (webView != null) {
                // Enable mixed content (HTTP API from HTTPS page)
                webView.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
                // Allow DOM storage for offline cache
                webView.getSettings().setDomStorageEnabled(true);
            }
        }
    }
}
