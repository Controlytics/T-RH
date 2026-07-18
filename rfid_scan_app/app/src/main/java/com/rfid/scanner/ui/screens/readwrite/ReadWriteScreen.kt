package com.rfid.scanner.ui.screens.readwrite

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
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReadWriteScreen(
    selectedEpc: String = "",
    viewModel: ReadWriteViewModel = viewModel()
) {
    val epc by viewModel.selectedEpc.collectAsState()
    val readResult by viewModel.readResult.collectAsState()
    val statusMessage by viewModel.statusMessage.collectAsState()
    val memoryBank by viewModel.memoryBank.collectAsState()
    val wordPtr by viewModel.wordPtr.collectAsState()
    val length by viewModel.length.collectAsState()
    val password by viewModel.password.collectAsState()
    val writeData by viewModel.writeData.collectAsState()
    val killPassword by viewModel.killPassword.collectAsState()
    val lockMemory by viewModel.lockMemory.collectAsState()
    val lockType by viewModel.lockType.collectAsState()

    // Set EPC if passed from scan screen
    if (selectedEpc.isNotEmpty() && selectedEpc != epc) {
        viewModel.setEpc(selectedEpc)
    }

    val memoryOptions = listOf("Reserved", "EPC", "TID", "User")
    val lockMemOptions = listOf("Kill Pwd", "Access Pwd", "EPC", "TID", "User")
    val lockTypeOptions = listOf("No Protection", "Permanent R/W", "Password Protected", "Permanent Lock")

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
                color = if (statusMessage.contains("successful")) Color(0xFF4CAF50) else Color.Red,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(8.dp))
        }

        // EPC
        OutlinedTextField(
            value = epc,
            onValueChange = { viewModel.setEpc(it) },
            label = { Text("EPC") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Memory Bank Dropdown
        DropdownSelector(
            label = "Memory Bank",
            options = memoryOptions,
            selectedIndex = memoryBank,
            onSelected = { viewModel.setMemoryBank(it) }
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Word Pointer & Length
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedTextField(
                value = "$wordPtr",
                onValueChange = { viewModel.setWordPtr(it.toIntOrNull() ?: 0) },
                label = { Text("Word Ptr") },
                modifier = Modifier.weight(1f)
            )
            OutlinedTextField(
                value = "$length",
                onValueChange = { viewModel.setLength(it.toIntOrNull() ?: 6) },
                label = { Text("Length") },
                modifier = Modifier.weight(1f)
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Password
        OutlinedTextField(
            value = password,
            onValueChange = { viewModel.setPassword(it) },
            label = { Text("Access Password") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Read Result
        OutlinedTextField(
            value = readResult,
            onValueChange = {},
            label = { Text("Read Result") },
            modifier = Modifier.fillMaxWidth(),
            readOnly = true
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Read Button
        Button(
            onClick = { viewModel.readData() },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text("Read")
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Write Data
        OutlinedTextField(
            value = writeData,
            onValueChange = { viewModel.setWriteData(it) },
            label = { Text("Write Data (hex)") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Write Buttons
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = { viewModel.writeData() },
                modifier = Modifier.weight(1f)
            ) {
                Text("Write")
            }
            OutlinedButton(
                onClick = { viewModel.writeEpc() },
                modifier = Modifier.weight(1f)
            ) {
                Text("Write EPC")
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Lock Section
        Text("Lock / Kill", fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Spacer(modifier = Modifier.height(8.dp))

        DropdownSelector(
            label = "Lock Memory",
            options = lockMemOptions,
            selectedIndex = lockMemory,
            onSelected = { viewModel.setLockMemory(it) }
        )

        Spacer(modifier = Modifier.height(8.dp))

        DropdownSelector(
            label = "Lock Type",
            options = lockTypeOptions,
            selectedIndex = lockType,
            onSelected = { viewModel.setLockType(it) }
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Kill Password
        OutlinedTextField(
            value = killPassword,
            onValueChange = { viewModel.setKillPassword(it) },
            label = { Text("Kill Password") },
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Lock & Kill Buttons
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Button(
                onClick = { viewModel.lockTag() },
                modifier = Modifier.weight(1f)
            ) {
                Text("Lock")
            }
            Button(
                onClick = { viewModel.killTag() },
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(containerColor = Color.Red)
            ) {
                Text("Kill")
            }
        }

        Spacer(modifier = Modifier.height(16.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DropdownSelector(
    label: String,
    options: List<String>,
    selectedIndex: Int,
    onSelected: (Int) -> Unit
) {
    var expanded by remember { mutableStateOf(false) }

    ExposedDropdownMenuBox(
        expanded = expanded,
        onExpandedChange = { expanded = !expanded }
    ) {
        OutlinedTextField(
            value = options.getOrElse(selectedIndex) { "" },
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor()
        )
        ExposedDropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false }
        ) {
            options.forEachIndexed { index, option ->
                DropdownMenuItem(
                    text = { Text(option) },
                    onClick = {
                        onSelected(index)
                        expanded = false
                    }
                )
            }
        }
    }
}
