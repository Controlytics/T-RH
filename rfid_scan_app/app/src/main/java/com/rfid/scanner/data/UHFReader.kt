package com.rfid.scanner.data

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.media.SoundPool
import com.rfid.trans.ReaderHelp
import com.rfid.trans.ReaderParameter
import com.rfid.trans.TagCallback

object UHFReader {

    val reader: ReaderHelp = ReaderHelp()

    private var soundPool: SoundPool? = null
    private var soundId: Int = 0

    // Connect to RFID reader via USB
    fun connect(device: UsbDevice, manager: UsbManager): Int {
        return reader.Connect(device, manager, 1)
    }

    // Disconnect from RFID reader
    fun disconnect(): Int {
        return reader.DisConnect()
    }

    // Check if reader is connected
    fun isConnected(): Boolean {
        return reader.isConnect
    }

    // Start continuous inventory
    fun startRead(): Int {
        return reader.StartRead()
    }

    // Stop inventory
    fun stopRead() {
        reader.StopRead()
    }

    // Set tag callback for receiving scanned tags
    fun setCallback(callback: TagCallback) {
        reader.SetCallBack(callback)
    }

    // Get inventory parameters
    fun getParams(): ReaderParameter {
        return reader.GetInventoryPatameter()
    }

    // Set inventory parameters
    fun setParams(param: ReaderParameter) {
        reader.SetInventoryPatameter(param)
    }

    // Read tag memory
    fun readData(epcId: String, mem: Byte, wordPtr: Int, num: Byte, password: String): String? {
        return reader.ReadData_G2(epcId, mem, wordPtr, num, password)
    }

    // Write data to tag memory
    fun writeData(data: String, epcId: String, mem: Byte, wordPtr: Int, password: String): Int {
        return reader.WriteData_G2(data, epcId, mem, wordPtr, password)
    }

    // Write EPC to tag
    fun writeEpc(epcId: String, password: String): Int {
        return reader.WriteEPC_G2(epcId, password)
    }

    // Lock tag
    fun lockTag(epcLen: Byte, epc: ByteArray?, select: Byte, setProtect: Byte, password: ByteArray?, errorCode: ByteArray?): Int {
        return reader.Lock_G2(epcLen, epc, select, setProtect, password, errorCode)
    }

    // Kill tag
    fun killTag(epcLen: Byte, epc: ByteArray?, password: ByteArray?, errorCode: ByteArray?): Int {
        return reader.Kill_G2(epcLen, epc, password, errorCode)
    }

    // Set RF power (0-33 dBm)
    fun setPower(power: Byte): Int {
        return reader.SetRfPower(power)
    }

    // Set frequency region
    fun setRegion(band: Byte, maxFre: Byte, minFre: Byte): Int {
        return reader.SetRegion(band, maxFre, minFre)
    }

    // Get reader information
    fun getReaderInfo(version: ByteArray, power: ByteArray, band: ByteArray, maxFre: ByteArray, minFre: ByteArray): Int {
        return reader.GetReaderInformation(version, power, band, maxFre, minFre)
    }

    // Get device serial number
    fun getDeviceId(): String {
        return reader.GetDeviceID()
    }

    // Set work mode (0 = answer mode, 9 = UKB mode)
    fun setWorkMode(mode: Byte): Int {
        return reader.SetWorkMode(mode)
    }

    // Get work mode
    fun getWorkMode(mode: ByteArray): Int {
        return reader.GetWorkMode(mode)
    }

    // Set/Get config parameters (for UKB settings)
    fun setCfgParameter(opt: Byte, cfgNo: Byte, cfgData: ByteArray, len: Int): Int {
        return reader.SetCfgParameter(opt, cfgNo, cfgData, len)
    }

    fun getCfgParameter(cfgNo: Byte, cfgData: ByteArray, len: IntArray): Int {
        return reader.GetCfgParameter(cfgNo, cfgData, len)
    }

    // Initialize beep sound
    fun initSound(soundId: Int, soundPool: SoundPool) {
        this.soundId = soundId
        this.soundPool = soundPool
        reader.SetSoundID(soundId, soundPool)
    }
}
