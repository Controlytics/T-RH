package com.rfid.scanner.ui.screens.connect

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.media.SoundPool
import android.os.Build
import androidx.lifecycle.ViewModel
import com.rfid.scanner.MainActivity
import com.rfid.scanner.R
import com.rfid.scanner.data.UHFReader
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class ConnectViewModel : ViewModel()  {
    private val _isConnected = MutableStateFlow(false)
    val isConnected: StateFlow<Boolean> = _isConnected

    private val _statusMessage = MutableStateFlow("Starting...")
    val statusMessage: StateFlow<String> = _statusMessage

    private var usbDevice: UsbDevice? = null
    private var usbManager: UsbManager? = null
    private var initError: String? = null

    init {
        try {
            // Test if RFID SDK loads properly
            val connected = UHFReader.isConnected()
            _statusMessage.value = "SDK loaded. Plug in RFID reader and tap Search."
        } catch (e: Exception) {
            initError = "SDK Error: ${e.message}"
            _statusMessage.value = initError!!
        }
    }

    companion object {
        const val ACTION_USB_PERMISSION = "com.rfid.scanner.USB_PERMISSION"
        const val VENDOR_ID = 10473
        const val PRODUCT_ID = 20993
    }

    fun findDevice(context: Context){
        usbManager = context.getSystemService(Context.USB_SERVICE) as UsbManager

        // Check if device came from USB intent (auto-launch)
        val intentDevice = MainActivity.usbDeviceFromIntent
        if (intentDevice != null) {
            usbDevice = intentDevice
            _statusMessage.value = "RFID Reader detected (VID:${intentDevice.vendorId} PID:${intentDevice.productId}). Click Connect."
            return
        }

        // Otherwise scan all USB devices
        val deviceList = usbManager?.deviceList

        if (deviceList.isNullOrEmpty()){
            _statusMessage.value = "No USB devices found. Please plug in the RFID reader."
            return
        }

        // First try exact match
        for (device in deviceList.values){
            if(device.vendorId == VENDOR_ID && device.productId == PRODUCT_ID){
                usbDevice = device
                _statusMessage.value = "RFID Reader found! Click Connect."
                return
            }
        }

        // If no exact match, try first available USB device
        val deviceInfo = StringBuilder()
        for (device in deviceList.values){
            deviceInfo.append("VID:${device.vendorId} PID:${device.productId}\n")
            if (usbDevice == null) {
                usbDevice = device
            }
        }

        if (usbDevice != null) {
            _statusMessage.value = "USB device found (VID:${usbDevice!!.vendorId} PID:${usbDevice!!.productId}). Click Connect."
        } else {
            _statusMessage.value = "No RFID Reader found.\n$deviceInfo"
        }
    }

    fun requestPermission(context: Context) {
        val device = usbDevice
        val manager = usbManager

        if (device == null || manager == null) {
            _statusMessage.value = "No device found. Tap Search first."
            return
        }

        try {
            if (manager.hasPermission(device)) {
                connect(context)
            } else {
                val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                } else {
                    PendingIntent.FLAG_UPDATE_CURRENT
                }
                val permissionIntent = PendingIntent.getBroadcast(
                    context, 0,
                    Intent(ACTION_USB_PERMISSION),
                    flags
                )
                manager.requestPermission(device, permissionIntent)
                _statusMessage.value = "Requesting USB permission..."
            }
        } catch (e: Exception) {
            _statusMessage.value = "Permission error: ${e.message}"
        }
    }

    fun connect(context: Context) {
        val device = usbDevice

        if (device == null) {
            _statusMessage.value = "No device found."
            return
        }

        try {
            // Get a FRESH UsbManager right before connecting (like the old demo app)
            val freshManager = context.getSystemService(Context.USB_SERVICE) as UsbManager

            // Make sure we have permission
            if (!freshManager.hasPermission(device)) {
                _statusMessage.value = "No USB permission. Click Connect again."
                requestPermission(context)
                return
            }

            _statusMessage.value = "Connecting..."
            val result = UHFReader.connect(device, freshManager)
            if (result == 0) {
                _isConnected.value = true
                _statusMessage.value = "Connected successfully!"
                initReader(context)
            } else {
                _statusMessage.value = "Connection failed. Error code: $result"
            }
        } catch (e: Exception) {
            _statusMessage.value = "Connection error: ${e.message}\n${e.stackTraceToString().take(200)}"
        }
    }

    private fun initReader(context: Context) {
        try {
            val param = UHFReader.getParams()
            param.Session = 0
            UHFReader.setParams(param)

            val soundPool = SoundPool.Builder()
                .setMaxStreams(10)
                .build()
            val soundId = soundPool.load(context, R.raw.barcodebeep, 1)
            UHFReader.initSound(soundId, soundPool)
        } catch (e: Exception) {
            _statusMessage.value = "Connected but init error: ${e.message}"
        }
    }



    fun disconnect() {
        try {
            UHFReader.disconnect()
            _isConnected.value = false
            _statusMessage.value = "Disconnected"
        }
        catch(e:Exception){
            _statusMessage.value = "Disconnect ERROR: ${e.message}"
        }

    }
    override fun onCleared() {
        super.onCleared()
        // Don't disconnect here! The reader should stay connected
        // when navigating to the main screen.
        // Disconnect is handled by MainActivity onDestroy.
    }
}