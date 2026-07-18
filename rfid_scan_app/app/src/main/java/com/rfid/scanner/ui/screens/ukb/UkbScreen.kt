package com.rfid.scanner.ui.screens.ukb

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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.lifecycle.viewmodel.compose.viewModel
import com.rfid.scanner.ui.screens.readwrite.DropdownSelector

@Composable
fun UkbScreen(
    viewModel: UkbViewModel = viewModel()
) {
    val statusMessage by viewModel.statusMessage.collectAsState()
    val cutData by viewModel.cutData.collectAsState()
    val align by viewModel.align.collectAsState()
    val dataOffset by viewModel.dataOffset.collectAsState()
    val dataLength by viewModel.dataLength.collectAsState()
    val format by viewModel.format.collectAsState()
    val startChar by viewModel.startChar.collectAsState()
    val endChar by viewModel.endChar.collectAsState()
    val addEnter by viewModel.addEnter.collectAsState()
    val byteInterval by viewModel.byteInterval.collectAsState()
    val tagInterval by viewModel.tagInterval.collectAsState()
    val filterTime by viewModel.filterTime.collectAsState()

    val enableDisable = listOf("Disable", "Enable")
    val formatOptions = listOf("Hex", "ASCII")

    LaunchedEffect(Unit) {
        viewModel.getParams()
    }

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

        // Cut Data
        DropdownSelector(
            label = "Cut Data",
            options = enableDisable,
            selectedIndex = cutData,
            onSelected = { viewModel.setCutData(it) }
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Align
        DropdownSelector(
            label = "Align",
            options = listOf("Left", "Right"),
            selectedIndex = align,
            onSelected = { viewModel.setAlign(it) }
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Data Offset
        Text(text = "Data Offset: $dataOffset", fontWeight = FontWeight.Bold)
        Slider(
            value = dataOffset.toFloat(),
            onValueChange = { viewModel.setDataOffset(it.toInt()) },
            valueRange = 0f..64f,
            steps = 63,
            modifier = Modifier.fillMaxWidth()
        )

        // Data Length
        Text(text = "Data Length: $dataLength", fontWeight = FontWeight.Bold)
        Slider(
            value = dataLength.toFloat(),
            onValueChange = { viewModel.setDataLength(it.toInt()) },
            valueRange = 1f..64f,
            steps = 62,
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Format
        DropdownSelector(
            label = "Output Format",
            options = formatOptions,
            selectedIndex = format,
            onSelected = { viewModel.setFormat(it) }
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Start / End characters
        OutlinedTextField(
            value = startChar,
            onValueChange = { viewModel.setStartChar(it) },
            label = { Text("Start Character") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))

        OutlinedTextField(
            value = endChar,
            onValueChange = { viewModel.setEndChar(it) },
            label = { Text("End Character") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Add Enter
        DropdownSelector(
            label = "Add Enter",
            options = enableDisable,
            selectedIndex = addEnter,
            onSelected = { viewModel.setAddEnter(it) }
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Byte Interval
        Text(text = "Byte Interval: ${byteInterval}ms", fontWeight = FontWeight.Bold)
        Slider(
            value = byteInterval.toFloat(),
            onValueChange = { viewModel.setByteInterval(it.toInt()) },
            valueRange = 1f..255f,
            steps = 253,
            modifier = Modifier.fillMaxWidth()
        )

        // Tag Interval
        Text(text = "Tag Interval: ${tagInterval * 10}ms", fontWeight = FontWeight.Bold)
        Slider(
            value = tagInterval.toFloat(),
            onValueChange = { viewModel.setTagInterval(it.toInt()) },
            valueRange = 0f..255f,
            steps = 254,
            modifier = Modifier.fillMaxWidth()
        )

        // Filter Time
        Text(text = "Filter Time: ${filterTime * 100}ms", fontWeight = FontWeight.Bold)
        Slider(
            value = filterTime.toFloat(),
            onValueChange = { viewModel.setFilterTime(it.toInt()) },
            valueRange = 0f..255f,
            steps = 254,
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Buttons
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = { viewModel.setParams() },
                modifier = Modifier.weight(1f)
            ) {
                Text("Save")
            }
            OutlinedButton(
                onClick = { viewModel.getParams() },
                modifier = Modifier.weight(1f)
            ) {
                Text("Refresh")
            }
        }

        Spacer(modifier = Modifier.height(16.dp))
    }
}
