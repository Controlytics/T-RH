package com.digilog.filtermanagement;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.rfid.trans.ReadTag;
import com.rfid.trans.ReaderHelp;
import com.rfid.trans.TagCallback;

import java.util.HashMap;
import java.util.Iterator;

/**
 * RfidPlugin — bridge between the Reader_Usb.jar SDK (KC-series UHF readers)
 * and JavaScript via Capacitor.
 *
 * Why this exists: when the RFID reader runs in SDK / answer mode (not UKB
 * keyboard mode) the OS does not inject keystrokes into the focused app, so
 * the React WebView never sees the tag. The standalone rfid_scan_app/ uses
 * Reader_Usb.jar to talk to the device directly. This plugin does the same,
 * then forwards each scanned tag to JS via notifyListeners("tag", ...).
 *
 * Usage from JS:
 *   import { Capacitor, registerPlugin } from '@capacitor/core';
 *   const Rfid = registerPlugin('Rfid');
 *   await Rfid.connect();
 *   await Rfid.startInventory();
 *   Rfid.addListener('tag', (e) => console.log('Got tag:', e.epc));
 *
 * Lifecycle:
 *   - connect()        — finds the USB RFID device, requests permission, opens it
 *   - startInventory() — begins continuous read; tags arrive via "tag" listener
 *   - disconnect()     — closes the USB connection (also stops any running read)
 */
@CapacitorPlugin(name = "Rfid")
public class RfidPlugin extends Plugin {
    private static final String TAG = "RfidPlugin";
    private static final String ACTION_USB_PERMISSION = "com.digilog.filtermanagement.USB_PERMISSION";

    private final ReaderHelp reader = new ReaderHelp();
    private boolean connected = false;
    private boolean inventoryRunning = false;
    private BroadcastReceiver usbPermissionReceiver;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        super.load();
        Log.i(TAG, "RfidPlugin loaded");
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (connected) {
            JSObject ret = new JSObject();
            ret.put("connected", true);
            ret.put("alreadyConnected", true);
            call.resolve(ret);
            return;
        }

        Context context = getContext();
        UsbManager manager = (UsbManager) context.getSystemService(Context.USB_SERVICE);
        if (manager == null) {
            call.reject("USB service not available");
            return;
        }

        UsbDevice device = pickRfidDevice(manager);
        if (device == null) {
            call.reject("No USB RFID device found. Plug in the reader and try again.");
            return;
        }

        if (manager.hasPermission(device)) {
            doConnect(device, manager, call);
            return;
        }

        // Request permission and finish the connect call from the broadcast receiver
        registerUsbPermissionReceiver(manager, call);
        int flags = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            ? PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
            : PendingIntent.FLAG_UPDATE_CURRENT;
        PendingIntent pi = PendingIntent.getBroadcast(context, 0, new Intent(ACTION_USB_PERMISSION), flags);
        manager.requestPermission(device, pi);
    }

    private void registerUsbPermissionReceiver(final UsbManager manager, final PluginCall call) {
        if (usbPermissionReceiver != null) return;
        usbPermissionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                if (!ACTION_USB_PERMISSION.equals(intent.getAction())) return;
                synchronized (this) {
                    UsbDevice device = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
                        ? intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice.class)
                        : intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                    boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                    if (granted && device != null) {
                        doConnect(device, manager, call);
                    } else {
                        call.reject("USB permission denied for RFID reader");
                    }
                    try { ctx.unregisterReceiver(usbPermissionReceiver); } catch (Exception ignored) {}
                    usbPermissionReceiver = null;
                }
            }
        };
        IntentFilter filter = new IntentFilter(ACTION_USB_PERMISSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(usbPermissionReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(usbPermissionReceiver, filter);
        }
    }

    private void doConnect(UsbDevice device, UsbManager manager, PluginCall call) {
        try {
            // Mode 1 = serial-over-USB. Reader_Usb.jar handles the UART conversion.
            int rc = reader.Connect(device, manager, 1);
            if (rc != 0) {
                call.reject("RFID Connect() failed with code " + rc);
                return;
            }
            connected = true;
            // Tag callback — Reader_Usb.jar v2 signature: tagCallback(ReadTag) +
            // StopReadCallBack(). Forward each tag to JS as a Capacitor event.
            reader.SetCallBack(new TagCallback() {
                @Override
                public void tagCallback(ReadTag tag) {
                    if (tag == null) return;
                    JSObject payload = new JSObject();
                    payload.put("epc", tag.epcId != null ? tag.epcId : "");
                    if (tag.memId != null) payload.put("tid", tag.memId);
                    payload.put("rssi", tag.rssi);
                    payload.put("antId", tag.antId);
                    payload.put("phase", tag.phase);
                    payload.put("ts", System.currentTimeMillis());
                    // Dispatch on main thread so JS handlers run cleanly
                    mainHandler.post(() -> notifyListeners("tag", payload));
                }

                @Override
                public void StopReadCallBack() {
                    mainHandler.post(() -> notifyListeners("inventoryStopped", new JSObject()));
                }
            });
            JSObject ret = new JSObject();
            ret.put("connected", true);
            ret.put("vendorId", device.getVendorId());
            ret.put("productId", device.getProductId());
            ret.put("deviceName", device.getDeviceName());
            call.resolve(ret);
        } catch (Throwable t) {
            Log.e(TAG, "doConnect failed", t);
            call.reject("Connect failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void startInventory(PluginCall call) {
        if (!connected) { call.reject("Not connected — call connect() first"); return; }
        try {
            int rc = reader.StartRead();
            if (rc != 0) { call.reject("StartRead() failed with code " + rc); return; }
            inventoryRunning = true;
            JSObject ret = new JSObject(); ret.put("started", true); call.resolve(ret);
        } catch (Throwable t) {
            call.reject("startInventory failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        try {
            if (inventoryRunning) {
                try { reader.StopRead(); } catch (Throwable ignored) {}
                inventoryRunning = false;
            }
            if (connected) {
                reader.DisConnect();
                connected = false;
            }
            JSObject ret = new JSObject(); ret.put("disconnected", true); call.resolve(ret);
        } catch (Throwable t) {
            call.reject("disconnect failed: " + t.getMessage());
        }
    }

    /**
     * Pick the first attached USB device whose vendor id matches one of the
     * KC-series UHF reader vendor IDs (mirrored from rfid_scan_app device_filter.xml).
     * If none match by vendor id but exactly one device is attached, return it
     * as a best-effort fallback.
     */
    private UsbDevice pickRfidDevice(UsbManager manager) {
        HashMap<String, UsbDevice> list = manager.getDeviceList();
        if (list == null || list.isEmpty()) return null;
        int[] knownVendors = { 10473, 1024, 4292, 6790, 1659 };
        for (UsbDevice d : list.values()) {
            int vid = d.getVendorId();
            for (int v : knownVendors) {
                if (vid == v) return d;
            }
        }
        // Fallback: a single attached device, even if vendor id is unknown
        if (list.size() == 1) {
            Iterator<UsbDevice> it = list.values().iterator();
            return it.hasNext() ? it.next() : null;
        }
        return null;
    }
}
