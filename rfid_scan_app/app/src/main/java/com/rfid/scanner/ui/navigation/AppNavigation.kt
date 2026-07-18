package com.rfid.scanner.ui.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Nfc
import androidx.compose.material.icons.filled.ReadMore
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Usb
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.rfid.scanner.ui.screens.connect.ConnectScreen
import com.rfid.scanner.ui.screens.readwrite.ReadWriteScreen
import com.rfid.scanner.ui.screens.scan.ScanScreen
import com.rfid.scanner.ui.screens.settings.SettingsScreen
import com.rfid.scanner.ui.screens.ukb.UkbScreen

sealed class Screen(val route: String, val title: String, val icon: ImageVector) {
    object Scan : Screen("scan", "Scan", Icons.Default.Nfc)
    object ReadWrite : Screen("readwrite", "Read/Write", Icons.Default.ReadMore)
    object Settings : Screen("settings", "Settings", Icons.Default.Settings)
    object Ukb : Screen("ukb", "UKB", Icons.Default.Usb)
}

@Composable
fun MainScreen() {
    val navController = rememberNavController()
    val screens = listOf(Screen.Scan, Screen.ReadWrite, Screen.Settings, Screen.Ukb)

    // Shared state for selected EPC between Scan and ReadWrite screens
    var selectedEpc by remember { mutableStateOf("") }

    Scaffold(
        bottomBar = {
            NavigationBar {
                val navBackStackEntry by navController.currentBackStackEntryAsState()
                val currentRoute = navBackStackEntry?.destination?.route

                screens.forEach { screen ->
                    NavigationBarItem(
                        icon = { Icon(screen.icon, contentDescription = screen.title) },
                        label = { Text(screen.title) },
                        selected = currentRoute == screen.route,
                        onClick = {
                            navController.navigate(screen.route) {
                                popUpTo(navController.graph.findStartDestination().id) {
                                    saveState = true
                                }
                                launchSingleTop = true
                                restoreState = true
                            }
                        }
                    )
                }
            }
        }
    ) { paddingValues ->
        NavHost(
            navController = navController,
            startDestination = Screen.Scan.route,
            modifier = Modifier.padding(paddingValues)
        ) {
            composable(Screen.Scan.route) {
                ScanScreen(
                    onTagSelected = { epc ->
                        selectedEpc = epc
                        navController.navigate(Screen.ReadWrite.route) {
                            launchSingleTop = true
                        }
                    }
                )
            }
            composable(Screen.ReadWrite.route) {
                ReadWriteScreen(selectedEpc = selectedEpc)
            }
            composable(Screen.Settings.route) {
                SettingsScreen()
            }
            composable(Screen.Ukb.route) {
                UkbScreen()
            }
        }
    }
}

@Composable
fun AppNavigation() {
    val navController = rememberNavController()

    NavHost(
        navController = navController,
        startDestination = "connect"
    ) {
        composable("connect") {
            ConnectScreen(
                onConnected = {
                    navController.navigate("main") {
                        popUpTo("connect") { inclusive = true }
                    }
                }
            )
        }
        composable("main") {
            MainScreen()
        }
    }
}
