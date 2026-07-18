package com.rfid.scanner.ui.screens.settings

import androidx.lifecycle.ViewModel
import com.rfid.scanner.data.UHFReader
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class SettingsViewModel : ViewModel() {

    private val _statusMessage = MutableStateFlow("")
    val statusMessage: StateFlow<String> = _statusMessage

    private val _firmwareVersion = MutableStateFlow("")
    val firmwareVersion: StateFlow<String> = _firmwareVersion

    private val _power = MutableStateFlow(33)
    val power: StateFlow<Int> = _power

    private val _band = MutableStateFlow(1)
    val band: StateFlow<Int> = _band

    private val _qValue = MutableStateFlow(4)
    val qValue: StateFlow<Int> = _qValue

    private val _session = MutableStateFlow(0)
    val session: StateFlow<Int> = _session

    private val _scanTime = MutableStateFlow(50)
    val scanTime: StateFlow<Int> = _scanTime

    private val _workMode = MutableStateFlow(0)
    val workMode: StateFlow<Int> = _workMode

    fun setPower(p: Int) { _power.value = p }
    fun setBand(b: Int) { _band.value = b }
    fun setQValue(q: Int) { _qValue.value = q }
    fun setSession(s: Int) { _session.value = s }
    fun setScanTime(t: Int) { _scanTime.value = t }
    fun setWorkMode(m: Int) { _workMode.value = m }

    fun readInfo() {
        try {
            val version = ByteArray(2)
            val power = ByteArray(1)
            val band = ByteArray(1)
            val maxFre = ByteArray(1)
            val minFre = ByteArray(1)

            val result = UHFReader.getReaderInfo(version, power, band, maxFre, minFre)
            if (result == 0) {
                val major = (version[0].toInt() and 0xFF).toString().padStart(2, '0')
                val minor = (version[1].toInt() and 0xFF).toString().padStart(2, '0')
                _firmwareVersion.value = "$major.$minor"
                _power.value = power[0].toInt() and 0xFF
                _band.value = band[0].toInt() and 0xFF
                _statusMessage.value = "Read info successful"
            } else {
                _statusMessage.value = "Read info failed"
            }
        } catch (e: Exception) {
            _statusMessage.value = "Error: ${e.message}"
        }
    }

    fun readParams() {
        try {
            val param = UHFReader.getParams()
            _qValue.value = param.QValue
            _session.value = param.Session
            _scanTime.value = param.ScanTime
            _statusMessage.value = "Read params successful"
        } catch (e: Exception) {
            _statusMessage.value = "Error: ${e.message}"
        }
    }

    fun saveSettings() {
        try {
            var errorMsg = ""

            // Set power
            val powerResult = UHFReader.setPower(_power.value.toByte())
            if (powerResult != 0) {
                errorMsg += "Power setting failed. "
            }

            // Set region
            val bandCode = when (_band.value) {
                0 -> 1   // Chinese band2
                1 -> 2   // US band
                2 -> 3   // Korean band
                3 -> 4   // EU band
                4 -> 8   // Chinese band1
                else -> 2
            }
            val regionResult = UHFReader.setRegion(bandCode.toByte(), 49.toByte(), 0.toByte())
            if (regionResult != 0) {
                errorMsg += "Region setting failed. "
            }

            // Set inventory parameters
            val param = UHFReader.getParams()
            param.QValue = _qValue.value
            param.Session = _session.value
            param.ScanTime = _scanTime.value
            param.Interval = 0
            UHFReader.setParams(param)

            if (errorMsg.isEmpty()) {
                _statusMessage.value = "Settings saved successfully"
            } else {
                _statusMessage.value = errorMsg
            }
        } catch (e: Exception) {
            _statusMessage.value = "Error: ${e.message}"
        }
    }

    fun readWorkMode() {
        try {
            val mode = ByteArray(50)
            val result = UHFReader.getWorkMode(mode)
            if (result == 0) {
                _workMode.value = if (mode[0].toInt() == 0) 0 else 1
                _statusMessage.value = "Work mode: ${if (_workMode.value == 0) "Answer Mode" else "UKB Mode"}"
            } else {
                _statusMessage.value = "Read work mode failed"
            }
        } catch (e: Exception) {
            _statusMessage.value = "Error: ${e.message}"
        }
    }

    fun setWorkModeSetting() {
        try {
            val modeValue: Byte = if (_workMode.value == 0) 0 else 9
            val result = UHFReader.setWorkMode(modeValue)
            if (result == 0) {
                _statusMessage.value = "Work mode set successfully"
            } else {
                _statusMessage.value = "Set work mode failed"
            }
        } catch (e: Exception) {
            _statusMessage.value = "Error: ${e.message}"
        }
    }
}
