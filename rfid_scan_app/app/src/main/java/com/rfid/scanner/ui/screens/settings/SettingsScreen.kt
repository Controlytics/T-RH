package com.rfid.scanner.ui.screens.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.rfid.scanner.ui.screens.readwrite.DropdownSelector

@Composable
fun SettingsScreen(
    viewModel: SettingsViewModel = viewModel()
) {
    val statusMessage by viewModel.statusMessage.collectAsState()
    val firmwareVersion by viewModel.firmwareVersion.collectAsState()
    val power by viewModel.power.collectAsState()
    val band by viewModel.band.collectAsState()
    val qValue by viewModel.qValue.collectAsState()
    val session by viewModel.session.collectAsState()
    val scanTime by viewModel.scanTime.collectAsState()
    val workMode by viewModel.workMode.collectAsState()

    LaunchedEffect(Unit) {
        viewModel.readInfo()
        viewModel.readParams()
    }

    val bandOptions = listOf("Chinese Band 2", "US Band", "Korean Band", "EU Band", "Chinese Band 1")
    val sessionOptions = listOf("S0", "S1", "S2", "S3")
    val workModeOptions = listOf("Answer Mode", "UKB Mode")

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
            .verticalScroll(rememberScrollState())
    ) {
        // Status
        if (statusMessage.isNotEmpty()) {
            Text(
                text = statusMessage,
                color = if (statusMessage.contains("successful") || statusMessage.contains("successfully")) Color(0xFF4CAF50) else Color.Red,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(8.dp))
        }

        // Firmware Version
        if (firmwareVersion.isNotEmpty()) {
            Text(text = "Firmware: v$firmwareVersion", fontSize = 14.sp, color = Color.Gray)
            Spacer(modifier = Modifier.height(12.dp))
        }

        // RF Power
        Text(text = "RF Power: $power dBm", fontWeight = FontWeight.Bold)
        Slider(
            value = power.toFloat(),
            onValueChange = { viewModel.setPower(it.toInt()) },
            valueRange = 0f..33f,
            steps = 32,
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(12.dp))

        // Frequency Band
        DropdownSelector(
            label = "Frequency Band",
            options = bandOptions,
            selectedIndex = band,
            onSelected = { viewModel.setBand(it) }
        )

        Spacer(modifier = Modifier.height(12.dp))

        // Q Value
        Text(text = "Q Value: $qValue", fontWeight = FontWeight.Bold)
        Slider(
            value = qValue.toFloat(),
            onValueChange = { viewModel.setQValue(it.toInt()) },
            valueRange = 0f..15f,
            steps = 14,
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(12.dp))

        // Session
        DropdownSelector(
            label = "Session",
            options = sessionOptions,
            selectedIndex = session,
            onSelected = { viewModel.setSession(it) }
        )

        Spacer(modifier = Modifier.height(12.dp))

        // Scan Time
        Text(text = "Scan Time: ${scanTime * 100}ms", fontWeight = FontWeight.Bold)
        Slider(
            value = scanTime.toFloat(),
            onValueChange = { viewModel.setScanTime(it.toInt()) },
            valueRange = 0f..255f,
            steps = 254,
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(12.dp))

        // Work Mode
        DropdownSelector(
            label = "Work Mode",
            options = workModeOptions,
            selectedIndex = workMode,
            onSelected = { viewModel.setWorkMode(it) }
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Buttons
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = { viewModel.saveSettings() },
                modifier = Modifier.weight(1f)
            ) {
                Text("Save Settings")
            }
            OutlinedButton(
                onClick = {
                    viewModel.readInfo()
                    viewModel.readParams()
                },
                modifier = Modifier.weight(1f)
            ) {
                Text("Refresh")
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = { viewModel.setWorkModeSetting() },
                modifier = Modifier.weight(1f)
            ) {
                Text("Set Work Mode")
            }
            OutlinedButton(
                onClick = { viewModel.readWorkMode() },
                modifier = Modifier.weight(1f)
            ) {
                Text("Read Work Mode")
            }
        }

        Spacer(modifier = Modifier.height(16.dp))
    }
}
