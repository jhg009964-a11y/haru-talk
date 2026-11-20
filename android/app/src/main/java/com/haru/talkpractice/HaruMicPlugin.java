package com.haru.talkpractice;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;

/**
 * Speech input for Haru's conversation loop.
 *
 * Unlike the community plugin it replaces, this one
 *  - keeps one SpeechRecognizer alive between turns (creating one costs 1–2 s each time),
 *  - reports every stage to the page as a "mic" event: ready / begin / partial / end / final / error,
 *    so the page knows the moment the mic can hear and reopens it immediately after an error,
 *  - does not use dictation mode, so the recognizer ends the turn shortly after the person stops talking.
 */
@CapacitorPlugin(name = "HaruMic", permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "mic") })
public class HaruMicPlugin extends Plugin {

    private SpeechRecognizer recognizer;
    private final Handler main = new Handler(Looper.getMainLooper());
    private int session = 0;
    private long startedAt = 0;

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "micPermission");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void micPermission(PluginCall call) {
        if (getPermissionState("mic") == PermissionState.GRANTED) begin(call);
        else call.reject("permission");
    }

    private void begin(PluginCall call) {
        final String language = call.getString("language", "ko-KR");
        final int silenceMs = call.getInt("silenceMs", 900);
        // tap-to-talk: dictation mode keeps listening through pauses until stop() is called
        final boolean continuous = Boolean.TRUE.equals(call.getBoolean("continuous", false));
        main.post(() -> {
            try {
                if (recognizer == null) {
                    if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                        call.reject("unavailable");
                        return;
                    }
                    recognizer = SpeechRecognizer.createSpeechRecognizer(getActivity());
                } else {
                    recognizer.cancel();
                }
                final int my = ++session;
                recognizer.setRecognitionListener(new Listener(my));

                Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
                intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
                intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
                intent.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, getContext().getPackageName());
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, silenceMs);
                intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, silenceMs);
                if (continuous) {
                    intent.putExtra("android.speech.extra.DICTATION_MODE", true);
                    intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 60000);
                }

                startedAt = SystemClock.elapsedRealtime();
                recognizer.startListening(intent);
                call.resolve(new JSObject().put("session", my));
            } catch (Exception e) {
                discard();
                call.reject(String.valueOf(e.getMessage()));
            }
        });
    }

    /** Ends listening and delivers the final words (as a "final" event). */
    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            try { if (recognizer != null) recognizer.stopListening(); } catch (Exception ignored) {}
            call.resolve();
        });
    }

    /** Ends listening and drops anything still on its way. */
    @PluginMethod
    public void cancel(PluginCall call) {
        main.post(() -> {
            session++;
            try { if (recognizer != null) recognizer.cancel(); } catch (Exception ignored) {}
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        main.post(this::discard);
    }

    private void discard() {
        try { if (recognizer != null) recognizer.destroy(); } catch (Exception ignored) {}
        recognizer = null;
    }

    private static String firstResult(Bundle b) {
        ArrayList<String> m = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return (m == null || m.isEmpty() || m.get(0) == null) ? "" : m.get(0);
    }

    private class Listener implements RecognitionListener {
        private final int my;

        Listener(int my) { this.my = my; }

        private void emit(String type, JSObject data) {
            if (my != session) return; // a newer start or a cancel replaced this one
            data.put("type", type);
            data.put("session", my);
            data.put("ms", SystemClock.elapsedRealtime() - startedAt);
            notifyListeners("mic", data);
        }

        @Override public void onReadyForSpeech(Bundle params) { emit("ready", new JSObject()); }
        @Override public void onBeginningOfSpeech() { emit("begin", new JSObject()); }
        @Override public void onRmsChanged(float rmsdB) {}
        @Override public void onBufferReceived(byte[] buffer) {}
        @Override public void onEndOfSpeech() { emit("end", new JSObject()); }

        @Override
        public void onError(int code) {
            JSObject d = new JSObject();
            d.put("code", code);
            emit("error", d);
            // client / busy / service-disconnected errors leave the recognizer unusable: make a fresh one next time
            if (code == SpeechRecognizer.ERROR_CLIENT || code == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || code == 11) {
                main.post(HaruMicPlugin.this::discard);
            }
        }

        @Override
        public void onResults(Bundle results) {
            JSObject d = new JSObject();
            d.put("text", firstResult(results));
            emit("final", d);
        }

        @Override
        public void onPartialResults(Bundle partial) {
            String t = firstResult(partial);
            if (t.isEmpty()) return;
            JSObject d = new JSObject();
            d.put("text", t);
            emit("partial", d);
        }

        @Override public void onEvent(int eventType, Bundle params) {}
    }
}
