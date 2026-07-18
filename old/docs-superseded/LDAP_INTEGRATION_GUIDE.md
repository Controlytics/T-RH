# LDAP / Active Directory Integration Guide

## DigiLog — Complete LDAP Setup, Configuration & Testing Manual

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Understanding LDAP Concepts](#3-understanding-ldap-concepts)
4. [How to Get LDAP Details from Your IT Team](#4-how-to-get-ldap-details-from-your-it-team)
5. [Getting the Bind DN](#5-getting-the-bind-dn)
6. [Getting the Bind Password](#6-getting-the-bind-password)
7. [TLS / SSL Certificate Setup](#7-tls--ssl-certificate-setup)
8. [Step-by-Step Configuration in DigiLog](#8-step-by-step-configuration-in-digilog)
9. [Attribute Mapping Reference](#9-attribute-mapping-reference)
10. [Group-to-Role Mapping](#10-group-to-role-mapping)
11. [Testing the Integration](#11-testing-the-integration)
12. [User Login Flow](#12-user-login-flow)
13. [Troubleshooting](#13-troubleshooting)
14. [Security Best Practices](#14-security-best-practices)
15. [FAQ](#15-faq)

---

## 1. Overview

DigiLog supports LDAP (Lightweight Directory Access Protocol) and Microsoft Active Directory (AD) integration, allowing your employees to log in using their existing company credentials. When LDAP is enabled:

- Users authenticate against your company directory (AD/LDAP)
- New users are **automatically provisioned** in DigiLog on their first login
- User attributes (name, email, department) are **synced on every login**
- LDAP group memberships are **mapped to DigiLog roles**
- The **Super Admin** account always uses local authentication (LDAP-independent)

### Supported Directory Servers

| Server | Supported | Notes |
|--------|-----------|-------|
| Microsoft Active Directory | Yes | Most common, uses `sAMAccountName` |
| Azure AD / Entra ID (with LDAP connector) | Yes | Requires LDAP-compatible endpoint |
| OpenLDAP | Yes | Uses `uid` for username |
| FreeIPA | Yes | Uses `uid` for username |
| 389 Directory Server | Yes | Uses `uid` for username |
| Apache Directory Server | Yes | Uses `uid` for username |

---

## 2. Prerequisites

Before configuring LDAP in DigiLog, ensure:

- [ ] You have **Super Admin** access to DigiLog
- [ ] Your company has an LDAP or Active Directory server
- [ ] The DigiLog server (EC2) can reach the LDAP server over the network
- [ ] A **service account** has been created for DigiLog in your directory
- [ ] You have the LDAP server's **hostname/IP** and **port**
- [ ] If using LDAPS (recommended), you have the **TLS/SSL certificate**

### Network Requirements

| Protocol | Port | Description |
|----------|------|-------------|
| LDAP | 389 | Unencrypted (NOT recommended for production) |
| LDAPS | 636 | SSL/TLS encrypted (recommended) |
| LDAP + StartTLS | 389 | Upgrades to TLS on standard port |

> **Important:** Ensure the EC2 security group allows outbound traffic to your LDAP server on port 636 (or 389).

---

## 3. Understanding LDAP Concepts

### Key Terminology

| Term | Meaning | Example |
|------|---------|---------|
| **DN** (Distinguished Name) | Unique identifier for an entry in the directory | `CN=John Doe,OU=Users,DC=company,DC=com` |
| **Base DN** | The root of your LDAP tree to search under | `DC=company,DC=com` |
| **Search Base** | The OU (Organizational Unit) where users are stored | `OU=Users,DC=company,DC=com` |
| **Bind DN** | The service account DN used to connect to LDAP | `CN=svc_digilog,OU=Service Accounts,DC=company,DC=com` |
| **Bind Password** | Password for the service account | (set by your IT team) |
| **Search Filter** | LDAP query to find a user by username | `(sAMAccountName={{username}})` |
| **Attribute** | A property of an LDAP entry | `mail`, `displayName`, `department` |
| **OU** | Organizational Unit — a container in the directory | `OU=Engineering`, `OU=Operations` |
| **DC** | Domain Component — parts of the domain name | `DC=company,DC=com` for `company.com` |
| **CN** | Common Name — the name of the entry | `CN=John Doe`, `CN=svc_digilog` |

### LDAP Tree Structure (Example)

```
DC=company,DC=com                          <-- Root (Base DN)
|-- OU=Users                               <-- Search Base
|   |-- CN=John Doe                        <-- User entry
|   |-- CN=Jane Smith                      <-- User entry
|   +-- CN=Bob Wilson                      <-- User entry
|-- OU=Service Accounts
|   +-- CN=svc_digilog                     <-- Bind DN (service account)
|-- OU=Groups
|   |-- CN=DigiLog_Admins                  <-- LDAP group
|   |-- CN=DigiLog_Operators               <-- LDAP group
|   +-- CN=DigiLog_Viewers                 <-- LDAP group
+-- OU=Computers
```

---

## 4. How to Get LDAP Details from Your IT Team

Send the following request to your IT/System Administrator:

---

**Subject: LDAP Service Account Request for DigiLog Application**

Hi [IT Admin],

We need to integrate our DigiLog application with Active Directory / LDAP for user authentication. Could you please provide or set up the following:

1. **LDAP Server URL** — hostname and port (e.g., `ldaps://ad.company.com:636`)
2. **Service Account** — a dedicated read-only service account for DigiLog
   - DN (Distinguished Name) of the account
   - Password for the account
3. **Search Base DN** — the OU where user accounts are located (e.g., `OU=Users,DC=company,DC=com`)
4. **SSL/TLS Certificate** — if using LDAPS, the CA certificate or server certificate
5. **User groups** — any LDAP groups created for DigiLog role mapping (e.g., `DigiLog_Admins`, `DigiLog_Operators`)

The service account only needs **read access** to:
- Search and read user attributes (name, email, department)
- Read group memberships

Thank you!

---

## 5. Getting the Bind DN

The **Bind DN** is the Distinguished Name of the service account that DigiLog uses to connect to your LDAP server.

### Option A: Ask Your IT Admin

Your IT admin will create a service account and give you the DN. It typically looks like:

```
CN=svc_digilog,OU=Service Accounts,DC=company,DC=com
```

### Option B: Find It Yourself (if you have AD access)

#### Using Active Directory Users and Computers (Windows)

1. Open **Active Directory Users and Computers** (`dsa.msc`)
2. Navigate to the service account
3. Right-click the account > **Properties** > **Attribute Editor** tab
4. Find the `distinguishedName` attribute — this is your **Bind DN**

#### Using PowerShell (Windows)

```powershell
# Find a specific user's DN
Get-ADUser -Identity "svc_digilog" | Select-Object DistinguishedName

# Search by name
Get-ADUser -Filter {Name -like "*digilog*"} | Select-Object Name, DistinguishedName

# List all service accounts in a specific OU
Get-ADUser -SearchBase "OU=Service Accounts,DC=company,DC=com" -Filter * | Select-Object Name, DistinguishedName
```

#### Using ldapsearch (Linux/Mac)

```bash
# Search for the service account
ldapsearch -x -H ldap://ad.company.com -D "admin@company.com" -W \
  -b "DC=company,DC=com" "(sAMAccountName=svc_digilog)" distinguishedName
```

### Common Bind DN Formats

| Directory Type | Format | Example |
|----------------|--------|---------|
| Active Directory | `CN=name,OU=...,DC=...,DC=...` | `CN=svc_digilog,OU=Service Accounts,DC=company,DC=com` |
| Active Directory (UPN) | `user@domain` | `svc_digilog@company.com` |
| OpenLDAP | `uid=name,ou=...,dc=...,dc=...` | `uid=svc_digilog,ou=services,dc=company,dc=com` |
| FreeIPA | `uid=name,cn=users,cn=accounts,dc=...,dc=...` | `uid=svc_digilog,cn=users,cn=accounts,dc=company,dc=com` |

---

## 6. Getting the Bind Password

The **Bind Password** is the password for the service account (Bind DN).

### How to Get It

1. **New service account**: Your IT admin sets the password when creating the account and shares it securely with you
2. **Existing account**: Ask IT to reset the password and share via a secure channel (password manager, encrypted email, etc.)

### Best Practices for the Service Account

- Use a **dedicated service account** — never use a personal admin account
- Set the password to **never expire** (or use a very long expiry)
- Grant **read-only** permissions (no write/modify access needed)
- Use a **strong password** (20+ characters, random)
- Store the password securely — DigiLog encrypts it in the database
- Name the account clearly (e.g., `svc_digilog`, `digilog-ldap`)

### Creating a Service Account in Active Directory

#### Using PowerShell (IT Admin)

```powershell
# Create the service account
New-ADUser -Name "svc_digilog" `
  -SamAccountName "svc_digilog" `
  -UserPrincipalName "svc_digilog@company.com" `
  -Path "OU=Service Accounts,DC=company,DC=com" `
  -AccountPassword (ConvertTo-SecureString "YourStrongPassword123!" -AsPlainText -Force) `
  -PasswordNeverExpires $true `
  -CannotChangePassword $true `
  -Enabled $true `
  -Description "Service account for DigiLog LDAP authentication"

# Verify
Get-ADUser -Identity "svc_digilog" | Select-Object DistinguishedName, Enabled
```

#### Using Active Directory Users and Computers (GUI)

1. Open **Active Directory Users and Computers**
2. Navigate to your Service Accounts OU
3. Right-click > **New** > **User**
4. Fill in: First name = `svc_digilog`, User logon name = `svc_digilog`
5. Set a strong password
6. Check **Password never expires**
7. Uncheck **User must change password at next logon**
8. Click **Finish**

---

## 7. TLS / SSL Certificate Setup

### Why TLS Matters

- **LDAP (port 389)**: Credentials sent in **plain text** — anyone on the network can intercept them
- **LDAPS (port 636)**: Credentials are **encrypted** — secure and recommended for production

### Option 1: Use LDAPS Without Certificate Verification (Quick Start)

In DigiLog LDAP config:
- Server URL: `ldaps://ad.company.com:636`
- **Uncheck** "Verify TLS Certificate"

This encrypts the connection but does not verify the server identity. Acceptable for internal networks.

### Option 2: Use LDAPS With Full Certificate Verification (Recommended)

#### Step 1: Get the CA Certificate

Ask your IT admin for the **CA (Certificate Authority) certificate** that signed the LDAP server's SSL certificate.

Or export it yourself:

**From Windows (if you have access to the AD server):**
```powershell
# Export the root CA certificate
certutil -ca.cert ca-cert.pem

# Or from the certificate store
$cert = Get-ChildItem -Path Cert:\LocalMachine\Root | Where-Object {$_.Subject -like "*YourCA*"}
[System.IO.File]::WriteAllBytes("ca-cert.pem", $cert.Export("Cert"))
```

**From a browser (any machine):**
1. Open `https://ad.company.com` in a browser (if there is a web interface)
2. Click the lock icon > **Certificate** > **Certification Path**
3. Click the root certificate > **View Certificate** > **Details** > **Copy to File**
4. Export as **Base-64 encoded X.509 (.CER/.PEM)**

**Using OpenSSL (Linux/Mac):**
```bash
# Download the certificate chain
openssl s_client -connect ad.company.com:636 -showcerts < /dev/null 2>/dev/null | \
  openssl x509 -outform PEM > ldap-ca-cert.pem

# Verify the certificate
openssl x509 -in ldap-ca-cert.pem -text -noout
```

#### Step 2: Install the Certificate on DigiLog Server

```bash
# SSH into the DigiLog server
ssh -i 21cfrbook.pem ubuntu@34.232.224.0

# Copy the certificate
sudo cp ldap-ca-cert.pem /usr/local/share/ca-certificates/ldap-ca-cert.crt
sudo update-ca-certificates

# Or set via environment variable
export NODE_EXTRA_CA_CERTS=/path/to/ldap-ca-cert.pem
```

#### Step 3: Enable Verification in DigiLog

In the LDAP config page:
- Check **"Verify TLS Certificate"**
- Save and test the connection

### Self-Signed Certificates

If your LDAP server uses a self-signed certificate:
1. Export the self-signed certificate (steps above)
2. Install it as a trusted CA on the DigiLog server
3. Or uncheck "Verify TLS Certificate" (less secure but functional)

---

## 8. Step-by-Step Configuration in DigiLog

### Step 1: Login as Super Admin

1. Open `http://34.232.224.0` in your browser
2. Login with: **Username:** `superadmin` | **Password:** `Admin@123`

### Step 2: Navigate to LDAP Configuration

1. Click the **gear icon** (Config/Settings) in the sidebar
2. Click **"LDAP / Active Directory"**

### Step 3: Fill in Connection Settings

| Field | What to Enter | Example |
|-------|---------------|---------|
| **Enable LDAP** | Toggle ON | ON |
| **Server URL** | Your LDAP server address | `ldaps://ad.company.com:636` |
| **Bind DN** | Service account DN | `CN=svc_digilog,OU=Service Accounts,DC=company,DC=com` |
| **Bind Password** | Service account password | `YourStrongPassword123!` |
| **Connection Timeout** | Keep default or increase for slow networks | `5000` (5 seconds) |
| **Verify TLS Certificate** | Check if you have the CA cert installed | Checked/Unchecked |

### Step 4: Click "Test Connection"

- **Success**: You will see a green message "Successfully connected and authenticated to LDAP server"
- **Failure**: See [Troubleshooting](#13-troubleshooting) section below

### Step 5: Configure User Search Settings

| Field | What to Enter | Example (Active Directory) | Example (OpenLDAP) |
|-------|---------------|---------------------------|---------------------|
| **Search Base DN** | OU where users are located | `OU=Users,DC=company,DC=com` | `ou=people,dc=company,dc=com` |
| **Search Filter** | How to find users by username | `(sAMAccountName={{username}})` | `(uid={{username}})` |
| **Username Attribute** | LDAP attribute for username | `sAMAccountName` | `uid` |
| **Group Attribute** | LDAP attribute for group membership | `memberOf` | `memberOf` |

#### Common Search Filters

| Use Case | Filter |
|----------|--------|
| AD — by username | `(sAMAccountName={{username}})` |
| AD — by email | `(userPrincipalName={{username}})` |
| AD — enabled accounts only | `(&(sAMAccountName={{username}})(!(userAccountControl:1.2.840.113556.1.4.803:=2)))` |
| AD — specific group members only | `(&(sAMAccountName={{username}})(memberOf=CN=DigiLog_Users,OU=Groups,DC=company,DC=com))` |
| OpenLDAP — by uid | `(uid={{username}})` |
| OpenLDAP — by email | `(mail={{username}})` |

### Step 6: Configure Attribute Mapping

| Field | What to Enter | AD Default | OpenLDAP Default |
|-------|---------------|------------|------------------|
| **Full Name** | Attribute for display name | `displayName` | `cn` |
| **Email** | Attribute for email | `mail` | `mail` |
| **Department** | Attribute for department | `department` | `departmentNumber` |
| **Sync attributes on every login** | Keep checked to auto-update | Checked | Checked |

### Step 7: Configure Group-to-Role Mapping

Click **"Add Mapping"** to map LDAP groups to DigiLog roles:

| LDAP Group | DigiLog Role |
|------------|-------------|
| `CN=DigiLog_Admins,OU=Groups,DC=company,DC=com` | Tenant Admin |
| `CN=DigiLog_Managers,OU=Groups,DC=company,DC=com` | Manager |
| `CN=DigiLog_Operators,OU=Groups,DC=company,DC=com` | Operator |
| `CN=DigiLog_Viewers,OU=Groups,DC=company,DC=com` | Viewer |

Set the **Default Role** (for users not matching any group): `Operator`

### Step 8: Configure User Provisioning

| Field | What to Enter |
|-------|---------------|
| **Default Organization** | Select the organization for new LDAP users |

### Step 9: Save

Click **"Save Configuration"** — you will see a green success message.

---

## 9. Attribute Mapping Reference

### Microsoft Active Directory Attributes

| DigiLog Field | AD Attribute | Description | Example Value |
|---------------|-------------|-------------|---------------|
| Username | `sAMAccountName` | Windows login name | `jdoe` |
| Full Name | `displayName` | Display name | `John Doe` |
| Email | `mail` | Email address | `jdoe@company.com` |
| Department | `department` | Department name | `Engineering` |
| Groups | `memberOf` | Group memberships | `CN=Admins,OU=Groups,DC=...` |
| User DN | `distinguishedName` | Full DN | `CN=John Doe,OU=Users,DC=...` |

### OpenLDAP Attributes

| DigiLog Field | OpenLDAP Attribute | Description |
|---------------|-------------------|-------------|
| Username | `uid` | User identifier |
| Full Name | `cn` or `displayName` | Common name |
| Email | `mail` | Email address |
| Department | `departmentNumber` or `ou` | Department |
| Groups | `memberOf` | Group memberships |

### How to Find Available Attributes

**PowerShell (Active Directory):**
```powershell
# List all attributes for a specific user
Get-ADUser -Identity "jdoe" -Properties * | Format-List *

# List specific attributes
Get-ADUser -Identity "jdoe" -Properties displayName, mail, department, memberOf
```

**ldapsearch (Linux/Mac):**
```bash
ldapsearch -x -H ldaps://ad.company.com:636 \
  -D "CN=svc_digilog,OU=Service Accounts,DC=company,DC=com" -W \
  -b "OU=Users,DC=company,DC=com" \
  "(sAMAccountName=jdoe)" "*"
```

---

## 10. Group-to-Role Mapping

### DigiLog Role Hierarchy

| Role | Level | Permissions |
|------|-------|-------------|
| Super Admin | Highest | Full system access (local auth only) |
| Tenant Admin | High | Manage users, config, all features |
| Manager | Medium | Approve checklists, manage assets, view reports |
| Operator | Standard | Create checklists, view assets, daily operations |
| Viewer | Low | Read-only access |
| Checklist Only | Minimal | Only checklist features |

### Setting Up LDAP Groups in Active Directory

**PowerShell:**
```powershell
# Create groups for DigiLog
New-ADGroup -Name "DigiLog_Admins" -GroupScope Global -Path "OU=Groups,DC=company,DC=com" -Description "DigiLog Tenant Admin access"
New-ADGroup -Name "DigiLog_Managers" -GroupScope Global -Path "OU=Groups,DC=company,DC=com" -Description "DigiLog Manager access"
New-ADGroup -Name "DigiLog_Operators" -GroupScope Global -Path "OU=Groups,DC=company,DC=com" -Description "DigiLog Operator access"
New-ADGroup -Name "DigiLog_Viewers" -GroupScope Global -Path "OU=Groups,DC=company,DC=com" -Description "DigiLog Viewer access"

# Add users to groups
Add-ADGroupMember -Identity "DigiLog_Admins" -Members "jdoe", "jsmith"
Add-ADGroupMember -Identity "DigiLog_Operators" -Members "bwilson", "mlee"
```

### Mapping Priority

Mappings are evaluated **top to bottom** — the first matching group wins. Order your mappings from most privileged to least:

1. Admin group -> Tenant Admin
2. Manager group -> Manager
3. Operator group -> Operator
4. *(no match)* -> Default Role (Operator)

---

## 11. Testing the Integration

### Test 1: Connection Test (from DigiLog UI)

1. Go to **Config > LDAP**
2. Fill in the connection details
3. Click **"Test Connection"**
4. Expected: Green message "Successfully connected and authenticated to LDAP server"

### Test 2: Connection Test (from DigiLog Server CLI)

```bash
# SSH into the server
ssh -i 21cfrbook.pem ubuntu@34.232.224.0

# Test LDAP connectivity
ldapsearch -x -H ldaps://ad.company.com:636 \
  -D "CN=svc_digilog,OU=Service Accounts,DC=company,DC=com" -W \
  -b "OU=Users,DC=company,DC=com" \
  "(sAMAccountName=testuser)" displayName mail department memberOf

# If ldapsearch is not installed:
sudo apt install ldap-utils
```

### Test 3: Network Connectivity Test

```bash
# Test if the LDAP port is reachable
nc -zv ad.company.com 636
# or
telnet ad.company.com 636

# Test TLS handshake
openssl s_client -connect ad.company.com:636 -showcerts
```

### Test 4: User Login Test

1. Ensure LDAP is **enabled** in DigiLog config
2. **Logout** of DigiLog
3. Login with an **AD/LDAP username and password**
4. Expected: User logs in and appears in the Users list with `authSource: ldap`

### Test 5: User Provisioning Verification

After a new LDAP user logs in for the first time:

1. Go to **Users** page (as admin)
2. Find the newly created user
3. Verify:
   - Full name matches LDAP `displayName`
   - Email matches LDAP `mail`
   - Department matches LDAP `department`
   - Role matches the group mapping (or default role)

### Test 6: Attribute Sync Test

1. Change a user's `displayName` or `department` in Active Directory
2. Have the user log out and log back in to DigiLog
3. Verify the attribute is updated in DigiLog

### Test 7: Role Mapping Test

1. In AD, add a user to the `DigiLog_Admins` group
2. Have the user log out and log back in
3. Verify the user's role changed to Tenant Admin in DigiLog

### Test 8: Fallback Test

1. Disable/stop the LDAP server (or set an incorrect URL)
2. Login as `superadmin` with local credentials
3. Expected: Super Admin can still log in (local auth bypass)

---

## 12. User Login Flow

### Flow Diagram

```
User enters username + password on DigiLog login page
|
|-- Is user found in local DigiLog database?
|   |-- YES: Is user's authSource = 'ldap'?
|   |   |-- YES: Authenticate via LDAP
|   |   |   |-- Success -> Sync attributes -> Create session -> Login
|   |   |   +-- Failure -> Show "Invalid credentials"
|   |   +-- NO: Authenticate via local password
|   |       |-- Success -> Create session -> Login
|   |       +-- Failure -> Increment failed attempts -> Show error
|   |
|   +-- NO: Is LDAP enabled?
|       |-- YES: Try LDAP authentication
|       |   |-- Success -> Auto-provision user -> Create session -> Login
|       |   +-- Failure -> Show "Invalid credentials"
|       +-- NO: Show "Invalid credentials"
```

### What Happens on First Login (Auto-Provisioning)

When an LDAP user logs in for the first time:

1. DigiLog searches the local database — user not found
2. DigiLog checks if LDAP is enabled — yes
3. DigiLog binds to LDAP with the service account
4. DigiLog searches for the user in the Search Base
5. DigiLog verifies the user's password via LDAP bind
6. DigiLog creates a new local user with:
   - **Username**: from LDAP
   - **Full Name**: from `displayName`
   - **Email**: from `mail`
   - **Department**: from `department`
   - **Role**: from group mapping (or default role)
   - **Auth Source**: `ldap`
   - **Password**: `LDAP_EXTERNAL_AUTH` (sentinel — not a real password)
7. DigiLog creates a session and logs the user in

### Subsequent Logins

1. User found in local database with `authSource: ldap`
2. DigiLog authenticates against LDAP
3. If `syncAttributes` is enabled: updates name, email, department, role
4. Creates session and logs in

---

## 13. Troubleshooting

### Connection Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `ECONNREFUSED` | LDAP server not reachable | Check network, firewall, security group. Test: `nc -zv host port` |
| `ENOTFOUND` | DNS resolution failed | Verify the hostname. Try using the IP address instead |
| `ETIMEDOUT` | Connection timed out | Check if port 636/389 is open. Increase connection timeout |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | TLS certificate not trusted | Install the CA cert or uncheck "Verify TLS Certificate" |
| `DEPTH_ZERO_SELF_SIGNED_CERT` | Self-signed certificate | Install cert as trusted CA or uncheck TLS verification |
| `ECONNRESET` | Server closed the connection | Check if server requires specific TLS version |

### Authentication Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Invalid credentials (49)` | Wrong Bind DN or password | Verify the DN and password. Try logging in with the service account via other tools |
| `No such object (32)` | Search Base does not exist | Verify the Search Base DN. Check spelling and structure |
| `Insufficient access (50)` | Service account lacks permissions | Grant read access to the Users OU |
| User not found | Wrong search filter or search base | Test the filter with ldapsearch. Check the Search Base includes the user's OU |
| User found but password fails | Correct user, wrong password | Verify the user is entering their AD password. Check account is not locked in AD |

### Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using `ldap://` instead of `ldaps://` | Change to `ldaps://` and port 636 |
| Wrong port (389 with ldaps://) | Use port 636 for LDAPS |
| Typo in the Bind DN | Copy-paste from AD, verify with PowerShell |
| Search Base too narrow | Use a broader OU (e.g., `DC=company,DC=com`) |
| Search Base too broad | Narrow to specific OU for better performance |
| Using `uid` for Active Directory | AD uses `sAMAccountName`, not `uid` |
| Using `sAMAccountName` for OpenLDAP | OpenLDAP uses `uid` |
| Group DN is partial | Use the full DN: `CN=Group,OU=Groups,DC=company,DC=com` |

### Server-Side Debugging

```bash
# SSH into DigiLog server
ssh -i 21cfrbook.pem ubuntu@34.232.224.0

# Check API logs for LDAP errors
pm2 logs digilog-api --lines 50 | grep -i ldap

# Test LDAP search manually
ldapsearch -x -H ldaps://ad.company.com:636 \
  -D "CN=svc_digilog,OU=Service Accounts,DC=company,DC=com" -W \
  -b "OU=Users,DC=company,DC=com" \
  "(sAMAccountName=testuser)" dn displayName mail department memberOf

# Test network connectivity
nc -zv ad.company.com 636
curl -v telnet://ad.company.com:636

# Check TLS certificate
openssl s_client -connect ad.company.com:636 -showcerts < /dev/null
```

---

## 14. Security Best Practices

### Connection Security

- **Always use LDAPS** (port 636) — never use plain LDAP (port 389) in production
- **Enable TLS certificate verification** when possible
- Install and maintain up-to-date CA certificates on the DigiLog server

### Service Account Security

- Use a **dedicated read-only** service account
- Never use a personal or admin account as the Bind DN
- Set the password to **never expire** to prevent authentication outages
- Use a **strong, random password** (20+ characters)
- **Restrict the account's permissions** to only what DigiLog needs:
  - Read user attributes (name, email, department)
  - Read group memberships
  - No write, modify, or delete permissions

### Network Security

- **Restrict EC2 security group** outbound rules to only your LDAP server's IP and port
- Use **VPN or VPC peering** if the LDAP server is in a different network
- Never expose your LDAP server to the public internet

### Application Security

- DigiLog **masks the bind password** in API responses (shown as `********`)
- LDAP configuration changes are **audit logged**
- The **Super Admin** always authenticates locally — never depends on LDAP
- Failed LDAP login attempts follow the same **lockout policy** as local users

---

## 15. FAQ

**Q: Will existing local users be affected when I enable LDAP?**
A: No. Existing local users continue to authenticate with their local passwords. Only new users logging in with LDAP credentials will be provisioned as LDAP users.

**Q: Can a user have both local and LDAP authentication?**
A: No. Each user has a single `authSource` — either `local` or `ldap`. The Super Admin is always local.

**Q: What happens if the LDAP server goes down?**
A: LDAP users will not be able to log in. The Super Admin can still log in using local credentials. Once LDAP is restored, LDAP users can log in again. Consider setting up LDAP server redundancy.

**Q: Can I disable LDAP without affecting LDAP-provisioned users?**
A: When LDAP is disabled, LDAP-provisioned users will not be able to log in (since their passwords are not stored locally). To re-enable their access, either re-enable LDAP or manually set a local password for each user.

**Q: How do I migrate an LDAP user back to local authentication?**
A: Update the user's `authSource` to `local` in the database and set a password using the admin password reset feature.

**Q: Can I restrict which LDAP users can access DigiLog?**
A: Yes. Use a search filter that limits to specific group members:
```
(&(sAMAccountName={{username}})(memberOf=CN=DigiLog_Users,OU=Groups,DC=company,DC=com))
```

**Q: Does DigiLog store LDAP passwords?**
A: No. LDAP user passwords are never stored in DigiLog. Authentication is always performed against the LDAP server in real-time. The only password stored is the service account (Bind) password, which is needed to search for users.

**Q: How often are user attributes synced?**
A: If "Sync attributes on every login" is enabled, attributes are updated each time the user logs in. There is no background sync — it happens only at login time.

**Q: What if a user belongs to multiple LDAP groups that are mapped to different roles?**
A: The **first matching mapping wins** (top to bottom). Order your mappings from highest privilege to lowest.

**Q: Can I test LDAP without enabling it for all users?**
A: Yes. Use the **"Test Connection"** button to verify connectivity without enabling LDAP. You can also enable LDAP temporarily, test with one user, and disable it again.

---

## Quick Reference Card

```
+------------------------------------------------------------------+
|                    LDAP Quick Reference                          |
+------------------------------------------------------------------+
|                                                                  |
|  Server URL:     ldaps://ad.company.com:636                      |
|  Bind DN:        CN=svc_digilog,OU=Service Accounts,DC=...      |
|  Search Base:    OU=Users,DC=company,DC=com                      |
|  Search Filter:  (sAMAccountName={{username}})                   |
|                                                                  |
|  Attributes:     displayName, mail, department, memberOf         |
|  Default Port:   636 (LDAPS) / 389 (LDAP)                       |
|  Auth Flow:      Service Bind -> Search User -> User Bind        |
|                                                                  |
|  DigiLog Config: Config (gear icon) -> LDAP / Active Directory   |
|  Super Admin:    Always uses local auth (LDAP-independent)       |
|  Test:           Click "Test Connection" before enabling         |
|                                                                  |
+------------------------------------------------------------------+
```

---

*Document Version: 1.1 | Last Updated: 2026-04-04 | DigiLog Application*


> **Note:** Phase 2 (Digital FMS) does not affect LDAP integration. LDAP-authenticated users can access all filter management features (cleaning profiles, filter operations, PM schedules, equipment groups, etc.) based on their assigned permissions (52+ permissions available).


---

## Phase 3 Update (2026-04-07)

**RFID & Offline Operations:**
- RFID Scanner Android app (`rfid_scan_app/`) for KC-series UHF readers
- RFID keyboard guard prevents UKB tag input leaking into random fields
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header
- One identifier per entity (backend-enforced)
- Responsive layout with collapsible sidebar
- Error popups replace inline banners
- User creation auto-assigns org for admins
- `/api/roles/active` public endpoint for contact-admin page

See `CHANGELOG.md` for full details.
