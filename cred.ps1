param(
    [Parameter(Mandatory = $true)][string]$cmd,
    [string]$file
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AgCred
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);

    private const string Target = "gemini:antigravity";

    public static string Read()
    {
        IntPtr ptr;
        if (!CredRead(Target, 1, 0, out ptr))
        {
            throw new Exception("CredRead failed: " + Marshal.GetLastWin32Error());
        }
        try
        {
            CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            byte[] bytes = new byte[c.CredentialBlobSize];
            if (c.CredentialBlobSize > 0)
            {
                Marshal.Copy(c.CredentialBlob, bytes, 0, (int)c.CredentialBlobSize);
            }
            return Encoding.UTF8.GetString(bytes);
        }
        finally
        {
            CredFree(ptr);
        }
    }

    public static void Write(string json)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(json);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, blob, bytes.Length);
        try
        {
            CREDENTIAL c = new CREDENTIAL();
            c.Type = 1;
            c.TargetName = Target;
            c.CredentialBlobSize = (uint)bytes.Length;
            c.CredentialBlob = blob;
            c.Persist = 2;
            c.UserName = "antigravity";
            if (!CredWrite(ref c, 0))
            {
                throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error());
            }
        }
        finally
        {
            Marshal.FreeHGlobal(blob);
        }
    }
}
"@

Add-Type -TypeDefinition $src -Language CSharp

if ($cmd -eq 'read') {
    [Console]::Out.Write([AgCred]::Read())
}
elseif ($cmd -eq 'write') {
    $json = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
    [AgCred]::Write($json)
    [Console]::Out.Write('{"ok":true}')
}
else {
    [Console]::Out.Write('{"ok":false,"error":"unknown command"}')
}
