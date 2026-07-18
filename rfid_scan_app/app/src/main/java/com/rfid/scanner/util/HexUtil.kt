package com.rfid.scanner.util




object HexUtil {

    fun hexStringToBytes(hexString: String?): ByteArray? {
        if (hexString.isNullOrEmpty()) return null
        val hex = hexString.uppercase()
        val length = hex.length / 2
        val result = ByteArray(length)
        for (i in 0 until length) {
            val pos = i * 2
            result[i] = (charToByte(hex[pos]) shl 4 or charToByte(hex[pos + 1])).toByte()
        }
        return result
    }

    private fun charToByte(c: Char): Int {
        return "0123456789ABCDEF".indexOf(c)
    }
}
