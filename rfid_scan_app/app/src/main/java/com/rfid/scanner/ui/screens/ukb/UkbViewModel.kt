package com.rfid.scanner.ui.screens.ukb

import androidx.lifecycle.ViewModel
import com.rfid.scanner.data.UHFReader
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class UkbViewModel : ViewModel() {

    private val _statusMessage = MutableStateFlow("")
    val statusMessage: StateFlow<String> = _statusMessage

    private val _cutData = MutableStateFlow(0)
    val cutData: StateFlow<Int> = _cutData

    private val _align = MutableStateFlow(0)
    val align: StateFlow<Int> = _align

    private val _dataOffset = MutableStateFlow(0)
    val dataOffset: StateFlow<Int> = _dataOffset

    private val _dataLength = MutableStateFlow(12)
    val dataLength: StateFlow<Int> = _dataLength

    private val _format = MutableStateFlow(0)
    val format: StateFlow<Int> = _format

    private val _startChar = MutableStateFlow("")
    val startChar: StateFlow<String> = _startChar

    private val _endChar = MutableStateFlow("")
    val endChar: StateFlow<String> = _endChar

    private val _addEnter = MutableStateFlow(0)
    val addEnter: StateFlow<Int> = _addEnter

    private val _byteInterval = MutableStateFlow(3)
    val byteInterval: StateFlow<Int> = _byteInterval

    private val _tagInterval = MutableStateFlow(0)
    val tagInterval: StateFlow<Int> = _tagInterval

    private val _filterTime = MutableStateFlow(5)
    val filterTime: StateFlow<Int> = _filterTime

    fun setCutData(v: Int) { _cutData.value = v }
    fun setAlign(v: Int) { _align.value = v }
    fun setDataOffset(v: Int) { _dataOffset.value = v }
    fun setDataLength(v: Int) { _dataLength.value = v }
    fun setFormat(v: Int) { _format.value = v }
    fun setStartChar(v: String) { _startChar.value = v }
    fun setEndChar(v: String) { _endChar.value = v }
    fun setAddEnter(v: Int) { _addEnter.value = v }
    fun setByteInterval(v: Int) { _byteInterval.value = v }
    fun setTagInterval(v: Int) { _tagInterval.value = v }
    fun setFilterTime(v: Int) { _filterTime.value = v }

    fun getParams() {
        try {
            val cfgNo: Byte = 74
            val cfgData = ByteArray(256)
            val len = IntArray(1)
            val result = UHFReader.getCfgParameter(cfgNo, cfgData, len)
            if (result == 0) {
                _cutData.value = cfgData[0].toInt() and 0x01
                _align.value = (cfgData[0].toInt() shr 1) and 0x01
                _dataOffset.value = cfgData[1].toInt()
                _dataLength.value = cfgData[2].toInt()
                _format.value = cfgData[3].toInt()

                val startBytes = ByteArray(8)
                val endBytes = ByteArray(8)
                System.arraycopy(cfgData, 4, startBytes, 0, 8)
                System.arraycopy(cfgData, 12, endBytes, 0, 8)
                _startChar.value = extractString(startBytes)

                // Check for Enter (0x0A)
                var hasEnter = false
                for (i in 0 until 8) {
                    if (endBytes[i] == 0x0A.toByte()) {
                        endBytes[i] = 0
                        hasEnter = true
                        break
                    } else if (endBytes[i] == 0.toByte()) {
                        break
                    }
                }
                _addEnter.value = if (hasEnter) 1 else 0
                _endChar.value = extractString(endBytes)

                _byteInterval.value = cfgData[20].toInt()
                _tagInterval.value = cfgData[21].toInt()
                _filterTime.value = cfgData[22].toInt()

                _statusMessage.value = "Read UKB params successful"
            } else {
                _statusMessage.value = "Read UKB params failed"
            }
        } catch (e: Exception) {
            _statusMessage.value = "Error: ${e.message}"
        }
    }

    fun setParams() {
        try {
            var cutDataCtrl: Byte = 0
            if (_cutData.value == 1) cutDataCtrl = (cutDataCtrl.toInt() or 0x01).toByte()
            if (_align.value == 1) cutDataCtrl = (cutDataCtrl.toInt() or 0x02).toByte()

            val cfgData = ByteArray(256)
            cfgData[0] = cutDataCtrl
            cfgData[1] = _dataOffset.value.toByte()
            cfgData[2] = _dataLength.value.toByte()
            cfgData[3] = _format.value.toByte()

            // Start char
            val startBytes = ByteArray(8)
            if (_startChar.value.isNotEmpty()) {
                val bytes = _startChar.value.toByteArray()
                val len = minOf(bytes.size, 8)
                System.arraycopy(bytes, 0, startBytes, 0, len)
            }
            System.arraycopy(startBytes, 0, cfgData, 4, 8)

            // End char
            val endBytes = ByteArray(8)
            if (_endChar.value.isNotEmpty()) {
                val bytes = _endChar.value.toByteArray()
                val len = minOf(bytes.size, 7)
                System.arraycopy(bytes, 0, endBytes, 0, len)
                if (_addEnter.value == 1) endBytes[len] = 0x0A
            } else {
                if (_addEnter.value == 1) endBytes[0] = 0x0A
            }
            System.arraycopy(endBytes, 0, cfgData, 12, 8)

            cfgData[20] = _byteInterval.value.toByte()
            cfgData[21] = _tagInterval.value.toByte()
            cfgData[22] = _filterTime.value.toByte()

            val cfgNo: Byte = 74
            val opt: Byte = 0
            val result = UHFReader.setCfgParameter(opt, cfgNo, cfgData, 32)
            if (result == 0) {
                _statusMessage.value = "UKB params saved successfully"
            } else {
                _statusMessage.value = "Save UKB params failed"
            }
        } catch (e: Exception) {
            _statusMessage.value = "Error: ${e.message}"
        }
    }

    private fun extractString(bytes: ByteArray): String {
        var count = 0
        for (b in bytes) {
            if (b == 0.toByte()) break
            count++
        }
        return if (count > 0) String(bytes, 0, count) else ""
    }
}
