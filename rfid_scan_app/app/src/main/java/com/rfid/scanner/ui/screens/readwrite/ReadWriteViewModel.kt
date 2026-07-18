package com.rfid.scanner.ui.screens.readwrite

import androidx.lifecycle.ViewModel
import com.rfid.scanner.data.UHFReader
import com.rfid.scanner.util.HexUtil
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

class ReadWriteViewModel : ViewModel() {

    private val _selectedEpc = MutableStateFlow("")
    val selectedEpc: StateFlow<String> = _selectedEpc

    private val _readResult = MutableStateFlow("")
    val readResult: StateFlow<String> = _readResult

    private val _statusMessage = MutableStateFlow("")
    val statusMessage: StateFlow<String> = _statusMessage

    // Memory bank: 0=Reserved, 1=EPC, 2=TID, 3=User
    private val _memoryBank = MutableStateFlow(3)
    val memoryBank: StateFlow<Int> = _memoryBank

    private val _wordPtr = MutableStateFlow(0)
    val wordPtr: StateFlow<Int> = _wordPtr

    private val _length = MutableStateFlow(6)
    val length: StateFlow<Int> = _length

    private val _password = MutableStateFlow("00000000")
    val password: StateFlow<String> = _password

    private val _writeData = MutableStateFlow("")
    val writeData: StateFlow<String> = _writeData

    private val _killPassword = MutableStateFlow("")
    val killPassword: StateFlow<String> = _killPassword

    // Lock settings
    private val _lockMemory = MutableStateFlow(4)
    val lockMemory: StateFlow<Int> = _lockMemory

    private val _lockType = MutableStateFlow(2)
    val lockType: StateFlow<Int> = _lockType

    fun setEpc(epc: String) { _selectedEpc.value = epc }
    fun setMemoryBank(bank: Int) { _memoryBank.value = bank }
    fun setWordPtr(ptr: Int) { _wordPtr.value = ptr }
    fun setLength(len: Int) { _length.value = len }
    fun setPassword(pwd: String) { _password.value = pwd }
    fun setWriteData(data: String) { _writeData.value = data }
    fun setKillPassword(pwd: String) { _killPassword.value = pwd }
    fun setLockMemory(mem: Int) { _lockMemory.value = mem }
    fun setLockType(type: Int) { _lockType.value = type }

    fun readData() {
        try {
            val epc = _selectedEpc.value.trim().uppercase()
            val mem = _memoryBank.value.toByte()
            val ptr = _wordPtr.value
            val num = _length.value.toByte()
            val pwd = _password.value.trim()

            // Validate inputs
            if (epc.isEmpty()) {
                _statusMessage.value = "EPC is empty. Scan a tag first or enter EPC."
                return
            }
            if (epc.length % 4 != 0) {
                _statusMessage.value = "EPC length must be multiple of 4. Current: ${epc.length}"
                return
            }
            if (pwd.length != 8) {
                _statusMessage.value = "Password must be 8 hex chars. Current: ${pwd.length}"
                return
            }

            _statusMessage.value = "Reading... EPC:$epc Mem:$mem Ptr:$ptr Len:$num"

            val result = UHFReader.readData(epc, mem, ptr, num, pwd)
            if (result != null && result.isNotEmpty()) {
                _readResult.value = result
                _statusMessage.value = "Read successful"
            } else {
                _readResult.value = ""
                _statusMessage.value = "Read failed. Make sure tag is near the reader."
            }
        } catch (e: Exception) {
            _statusMessage.value = "Read error: ${e.message}"
        }
    }

    fun writeData() {
        try {
            val data = _writeData.value
            val epc = _selectedEpc.value
            val mem = _memoryBank.value.toByte()
            val ptr = _wordPtr.value
            val pwd = _password.value

            if (data.isEmpty() || data.length % 4 != 0) {
                _statusMessage.value = "Write data length must be multiple of 4"
                return
            }

            val result = UHFReader.writeData(data, epc, mem, ptr, pwd)
            if (result == 0) {
                _statusMessage.value = "Write successful"
            } else {
                _statusMessage.value = "Write failed. Error code: $result"
            }
        } catch (e: Exception) {
            _statusMessage.value = "Write error: ${e.message}"
        }
    }

    fun writeEpc() {
        try {
            val data = _writeData.value
            val pwd = _password.value

            if (data.isEmpty() || data.length % 4 != 0) {
                _statusMessage.value = "EPC data length must be multiple of 4"
                return
            }

            val result = UHFReader.writeEpc(data, pwd)
            if (result == 0) {
                _statusMessage.value = "Write EPC successful"
            } else {
                _statusMessage.value = "Write EPC failed. Error code: $result"
            }
        } catch (e: Exception) {
            _statusMessage.value = "Write EPC error: ${e.message}"
        }
    }

    fun lockTag() {
        try {
            val epc = _selectedEpc.value
            val pwd = _password.value
            val passwordBytes = HexUtil.hexStringToBytes(pwd)
            val epcLen = (epc.length / 4).toByte()
            val errorCode = ByteArray(1)
            val select = _lockMemory.value.toByte()
            val setProtect = _lockType.value.toByte()

            val result = UHFReader.lockTag(epcLen, null, select, setProtect, passwordBytes, errorCode)
            if (result == 0) {
                _statusMessage.value = "Lock successful"
            } else {
                _statusMessage.value = "Lock failed. Error code: $result"
            }
        } catch (e: Exception) {
            _statusMessage.value = "Lock error: ${e.message}"
        }
    }

    fun killTag() {
        try {
            val epc = _selectedEpc.value
            val killPwd = _killPassword.value

            if (killPwd.length != 8) {
                _statusMessage.value = "Kill password must be 8 hex characters"
                return
            }

            val passwordBytes = HexUtil.hexStringToBytes(killPwd)
            val epcLen = (epc.length / 4).toByte()
            val errorCode = ByteArray(1)

            val result = UHFReader.killTag(epcLen, null, passwordBytes, errorCode)
            if (result == 0) {
                _statusMessage.value = "Kill successful"
            } else {
                _statusMessage.value = "Kill failed. Error code: $result"
            }
        } catch (e: Exception) {
            _statusMessage.value = "Kill error: ${e.message}"
        }
    }
}
