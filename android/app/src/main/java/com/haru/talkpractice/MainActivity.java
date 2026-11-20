package com.haru.talkpractice;

import android.os.Bundle;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HaruMicPlugin.class);
        super.onCreate(savedInstanceState);
        // The app screens are loaded from GitHub Pages; skip the WebView cache so a new deploy shows up on the next launch.
        WebSettings s = getBridge().getWebView().getSettings();
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setMediaPlaybackRequiresUserGesture(false);
    }
}
