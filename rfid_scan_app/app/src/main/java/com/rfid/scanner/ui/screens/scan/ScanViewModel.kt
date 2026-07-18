package com.rfid.scanner.ui.screens.scan

import androidx.lifecycle.ViewModel
import com.rfid.scanner.data.UHFReader
import com.rfid.scanner.data.model.ScannedTag
import com.rfid.trans.ReadTag
import com.rfid.trans.TagCallback
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class ScanViewModel : ViewModel() {

    private val _tagList = MutableStateFlow<List<ScannedTag>>(emptyList())
    val tagList: StateFlow<List<ScannedTag>> = _tagList

    private val _isScanning = MutableStateFlow(false)
    val isScanning: StateFlow<Boolean> = _isScanning

    private val _totalReads = MutableStateFlow(0L)
    val totalReads: StateFlow<Long> = _totalReads

    private val _scanSpeed = MutableStateFlow(0)
    val scanSpeed: StateFlow<Int> = _scanSpeed

    private val _selectedEpc = MutableStateFlow("")
    val selectedEpc: StateFlow<String> = _selectedEpc

    private val _statusMessage = MutableStateFlow("")
    val statusMessage: StateFlow<String> = _statusMessage

    private var lastSpeedTime = 0L
    private var lastSpeedCount = 0

    private val callback = object : TagCallback {
        override fun tagCallback(tag: ReadTag?) {
            if (tag == null) return
            val epc = tag.epcId?.uppercase() ?: return
            val rssi = tag.rssi

            _totalReads.value++

            val currentList = _tagList.value.toMutableList()
            val index = currentList.indexOfFirst { it.epcId == epc }

            if (index == -1) {
                currentList.add(ScannedTag(epcId = epc, rssi = rssi))
            } else {
                val existing = currentList[index]
                currentList[index] = existing.copy(
                    rssi = rssi,
                    count = existing.count + 1
                )
            }
            _tagList.value = currentList

            // Calculate speed (tags per second)
            lastSpeedCount++
            val now = System.currentTimeMillis()
            if (now - lastSpeedTime >= 1000) {
                _scanSpeed.value = lastSpeedCount
                lastSpeedCount = 0
                lastSpeedTime = now
            }
        }

        override fun StopReadCallBack() {
            _isScanning.value = false
            _statusMessage.value = "Scan stopped"
        }
    }

    fun startScan() {
        if (_isScanning.value) return
        try {
            // Set callback every time before scanning
            UHFReader.setCallback(callback)

            // Check work mode first
            val mode = ByteArray(50)
            val modeResult = UHFReader.getWorkMode(mode)
            if (modeResult == 0 && mode[0].toInt() != 0) {
                _statusMessage.value = "Reader is in UKB mode. Switch to Answer mode in Settings."
                return
            }

            val result = UHFReader.startRead()
            if (result == 0) {
                _isScanning.value = true
                _statusMessage.value = "Scanning..."
                lastSpeedTime = System.currentTimeMillis()
                lastSpeedCount = 0
            } else {
                _statusMessage.value = "Scan failed. Error: $result"
            }
        } catch (e: Exception) {
            _statusMessage.value = "Scan error: ${e.message}"
        }
    }

    fun stopScan() {
        try {
            UHFReader.stopRead()
        } catch (e: Exception) {
            _statusMessage.value = "Stop error: ${e.message}"
        }
    }

    fun clearData() {
        _tagList.value = emptyList()
        _totalReads.value = 0
        _scanSpeed.value = 0
    }

    fun selectTag(epc: String) {
        _selectedEpc.value = epc
    }

    override fun onCleared() {
        super.onCleared()
        if (_isScanning.value) {
            UHFReader.stopRead()
        }
    }
}
