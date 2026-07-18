package com.rfid.scanner.data.model

data class ScannedTag (
    val epcId: String,
    val rssi: Int = 0,
    var count: Int = 1,
    val timestamp: Long = System.currentTimeMillis()

)