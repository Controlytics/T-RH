package com.rfid.scanner.ui.screens.scan

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.rfid.scanner.data.model.ScannedTag

@Composable
fun ScanScreen(
    viewModel: ScanViewModel = viewModel(),
    onTagSelected: (String) -> Unit = {}
) {
    val tagList by viewModel.tagList.collectAsState()
    val isScanning by viewModel.isScanning.collectAsState()
    val totalReads by viewModel.totalReads.collectAsState()
    val scanSpeed by viewModel.scanSpeed.collectAsState()
    val statusMessage by viewModel.statusMessage.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(16.dp)
    ) {
        // Status message
        if (statusMessage.isNotEmpty()) {
            Text(
                text = statusMessage,
                color = if (statusMessage.contains("error") || statusMessage.contains("failed") || statusMessage.contains("not"))
                    Color.Red else Color(0xFF4CAF50),
                fontSize = 13.sp
            )
            Spacer(modifier = Modifier.height(4.dp))
        }

        // Stats Row
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            StatCard("Tags", "${tagList.size}")
            StatCard("Total", "$totalReads")
            StatCard("Speed", "$scanSpeed/s")
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Buttons Row
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = {
                    if (isScanning) viewModel.stopScan() else viewModel.startScan()
                },
                modifier = Modifier.weight(1f),
                colors = if (isScanning) {
                    ButtonDefaults.buttonColors(containerColor = Color.Red)
                } else {
                    ButtonDefaults.buttonColors()
                }
            ) {
                Text(if (isScanning) "Stop" else "Scan")
            }

            OutlinedButton(
                onClick = { viewModel.clearData() },
                modifier = Modifier.weight(1f),
                enabled = !isScanning
            ) {
                Text("Clear")
            }
        }

        Spacer(modifier = Modifier.height(12.dp))

        // Header Row
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text("EPC", fontWeight = FontWeight.Bold, fontSize = 12.sp, modifier = Modifier.weight(3f))
            Text("Count", fontWeight = FontWeight.Bold, fontSize = 12.sp, modifier = Modifier.weight(1f))
            Text("RSSI", fontWeight = FontWeight.Bold, fontSize = 12.sp, modifier = Modifier.weight(1f))
        }

        Spacer(modifier = Modifier.height(4.dp))

        // Tag List
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            items(tagList) { tag ->
                TagItem(
                    tag = tag,
                    onClick = {
                        viewModel.stopScan()
                        viewModel.selectTag(tag.epcId)
                        onTagSelected(tag.epcId)
                    }
                )
            }
        }
    }
}

@Composable
fun StatCard(label: String, value: String) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer
        )
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Text(text = value, fontWeight = FontWeight.Bold, fontSize = 20.sp)
            Text(text = label, fontSize = 12.sp)
        }
    }
}

@Composable
fun TagItem(tag: ScannedTag, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onClick() },
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = tag.epcId,
                fontSize = 13.sp,
                modifier = Modifier.weight(3f)
            )
            Text(
                text = "${tag.count}",
                fontSize = 13.sp,
                modifier = Modifier.weight(1f)
            )
            Text(
                text = "${tag.rssi}",
                fontSize = 13.sp,
                modifier = Modifier.weight(1f)
            )
        }
    }
}
