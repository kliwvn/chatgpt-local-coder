using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace ChatGptLocalCoder.SandboxRunner
{
    internal sealed class BrokerRequest
    {
        public string operation { get; set; }
        public string profileName { get; set; }
        public string executable { get; set; }
        public string[] args { get; set; }
        public string cwd { get; set; }
        public Dictionary<string, string> env { get; set; }
        public string[] rwRoots { get; set; }
        public string[] rxRoots { get; set; }
        public string[] removeRoots { get; set; }
        public string networkMode { get; set; }
        public int timeoutMs { get; set; }
    }

    internal sealed class BrokerResponse
    {
        public bool ok { get; set; }
        public string operation { get; set; }
        public string backend { get; set; }
        public string profileName { get; set; }
        public string sid { get; set; }
        public string profilePath { get; set; }
        public string error { get; set; }
        public int nativeError { get; set; }
    }

    internal static class Native
    {
        internal const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        internal const uint CREATE_SUSPENDED = 0x00000004;
        internal const uint CREATE_NO_WINDOW = 0x08000000;
        internal const int STARTF_USESTDHANDLES = 0x00000100;
        internal const uint HANDLE_FLAG_INHERIT = 0x00000001;
        internal const uint SE_GROUP_ENABLED = 0x00000004;
        internal const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        internal const int JobObjectExtendedLimitInformation = 9;
        internal const uint READ_CONTROL = 0x00020000;
        internal const uint WRITE_DAC = 0x00040000;
        internal const uint FILE_SHARE_READ = 0x00000001;
        internal const uint FILE_SHARE_WRITE = 0x00000002;
        internal const uint OPEN_EXISTING = 3;
        internal const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        internal const uint DACL_SECURITY_INFORMATION = 0x00000004;
        internal const int SE_KERNEL_OBJECT = 6;
        internal const int SE_FILE_OBJECT = 1;
        internal const uint FILE_GENERIC_READ = 0x00120089;
        internal const uint FILE_GENERIC_WRITE = 0x00120116;
        internal const uint FILE_GENERIC_EXECUTE = 0x001200A0;
        internal const int SET_ACCESS = 2;
        internal const int REVOKE_ACCESS = 4;
        internal const int TRUSTEE_IS_SID = 0;
        internal const int TRUSTEE_IS_UNKNOWN = 0;
        internal const uint NO_INHERITANCE = 0;
        internal const uint SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3;
        internal const uint FILE_TRAVERSE = 0x20;
        internal const uint FILE_READ_ATTRIBUTES = 0x80;
        internal const uint SYNCHRONIZE = 0x00100000;
        internal static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
        internal static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = new IntPtr(0x00020009);
        internal const int ERROR_ALREADY_EXISTS = 183;
        internal const uint INFINITE = 0xFFFFFFFF;
        internal const uint WAIT_TIMEOUT = 0x00000102;

        [StructLayout(LayoutKind.Sequential)]
        internal struct SECURITY_ATTRIBUTES
        {
            internal int nLength;
            internal IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)] internal bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct STARTUPINFO
        {
            internal int cb;
            internal string lpReserved;
            internal string lpDesktop;
            internal string lpTitle;
            internal int dwX;
            internal int dwY;
            internal int dwXSize;
            internal int dwYSize;
            internal int dwXCountChars;
            internal int dwYCountChars;
            internal int dwFillAttribute;
            internal int dwFlags;
            internal short wShowWindow;
            internal short cbReserved2;
            internal IntPtr lpReserved2;
            internal IntPtr hStdInput;
            internal IntPtr hStdOutput;
            internal IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct STARTUPINFOEX
        {
            internal STARTUPINFO StartupInfo;
            internal IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct PROCESS_INFORMATION
        {
            internal IntPtr hProcess;
            internal IntPtr hThread;
            internal uint dwProcessId;
            internal uint dwThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct SECURITY_CAPABILITIES
        {
            internal IntPtr AppContainerSid;
            internal IntPtr Capabilities;
            internal uint CapabilityCount;
            internal uint Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct SID_AND_ATTRIBUTES
        {
            internal IntPtr Sid;
            internal uint Attributes;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct TRUSTEE_W
        {
            internal IntPtr pMultipleTrustee;
            internal int MultipleTrusteeOperation;
            internal int TrusteeForm;
            internal int TrusteeType;
            internal IntPtr ptstrName;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct EXPLICIT_ACCESS_W
        {
            internal uint grfAccessPermissions;
            internal int grfAccessMode;
            internal uint grfInheritance;
            internal TRUSTEE_W Trustee;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct IO_COUNTERS
        {
            internal ulong ReadOperationCount;
            internal ulong WriteOperationCount;
            internal ulong OtherOperationCount;
            internal ulong ReadTransferCount;
            internal ulong WriteTransferCount;
            internal ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            internal long PerProcessUserTimeLimit;
            internal long PerJobUserTimeLimit;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSetSize;
            internal UIntPtr MaximumWorkingSetSize;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass;
            internal uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            internal IO_COUNTERS IoInfo;
            internal UIntPtr ProcessMemoryLimit;
            internal UIntPtr JobMemoryLimit;
            internal UIntPtr PeakProcessMemoryUsed;
            internal UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
        internal static extern int CreateAppContainerProfile(
            string pszAppContainerName,
            string pszDisplayName,
            string pszDescription,
            IntPtr pCapabilities,
            uint dwCapabilityCount,
            out IntPtr ppSidAppContainerSid);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
        internal static extern int DeriveAppContainerSidFromAppContainerName(
            string pszAppContainerName,
            out IntPtr ppsidAppContainerSid);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
        internal static extern int DeleteAppContainerProfile(string pszAppContainerName);

        [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
        internal static extern int GetAppContainerFolderPath(string pszAppContainerSid, out IntPtr ppszPath);

        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern IntPtr FreeSid(IntPtr pSid);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ConvertSidToStringSid(IntPtr Sid, out IntPtr StringSid);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ConvertStringSidToSid(string StringSid, out IntPtr Sid);

        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern uint GetSecurityInfo(
            IntPtr handle,
            int ObjectType,
            uint SecurityInfo,
            IntPtr ppsidOwner,
            IntPtr ppsidGroup,
            out IntPtr ppDacl,
            IntPtr ppSacl,
            out IntPtr ppSecurityDescriptor);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern uint GetNamedSecurityInfo(
            string pObjectName,
            int ObjectType,
            uint SecurityInfo,
            IntPtr ppsidOwner,
            IntPtr ppsidGroup,
            out IntPtr ppDacl,
            IntPtr ppSacl,
            out IntPtr ppSecurityDescriptor);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern uint SetEntriesInAcl(
            uint cCountOfExplicitEntries,
            ref EXPLICIT_ACCESS_W pListOfExplicitEntries,
            IntPtr OldAcl,
            out IntPtr NewAcl);

        [DllImport("advapi32.dll", SetLastError = true)]
        internal static extern uint SetSecurityInfo(
            IntPtr handle,
            int ObjectType,
            uint SecurityInfo,
            IntPtr psidOwner,
            IntPtr psidGroup,
            IntPtr pDacl,
            IntPtr pSacl);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern uint SetNamedSecurityInfo(
            string pObjectName,
            int ObjectType,
            uint SecurityInfo,
            IntPtr psidOwner,
            IntPtr psidGroup,
            IntPtr pDacl,
            IntPtr pSacl);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr LocalFree(IntPtr hMem);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateFile(
            string lpFileName,
            uint dwDesiredAccess,
            uint dwShareMode,
            IntPtr lpSecurityAttributes,
            uint dwCreationDisposition,
            uint dwFlagsAndAttributes,
            IntPtr hTemplateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool InitializeProcThreadAttributeList(
            IntPtr lpAttributeList,
            int dwAttributeCount,
            int dwFlags,
            ref IntPtr lpSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool UpdateProcThreadAttribute(
            IntPtr lpAttributeList,
            uint dwFlags,
            IntPtr Attribute,
            IntPtr lpValue,
            IntPtr cbSize,
            IntPtr lpPreviousValue,
            IntPtr lpReturnSize);

        [DllImport("kernel32.dll")]
        internal static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreateProcess(
            string lpApplicationName,
            StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFOEX lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CreatePipe(
            out IntPtr hReadPipe,
            out IntPtr hWritePipe,
            ref SECURITY_ATTRIBUTES lpPipeAttributes,
            uint nSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetInformationJobObject(
            IntPtr hJob,
            int JobObjectInfoClass,
            IntPtr lpJobObjectInfo,
            uint cbJobObjectInfoLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr hObject);
    }

    internal sealed class AppContainerIdentity : IDisposable
    {
        internal string Name;
        internal IntPtr Sid;
        internal string SidString;
        internal string ProfilePath;

        public void Dispose()
        {
            if (Sid != IntPtr.Zero)
            {
                Native.FreeSid(Sid);
                Sid = IntPtr.Zero;
            }
        }
    }

    internal static class Program
    {
        private const int EXIT_USAGE = 200;
        private const int EXIT_PREPARE = 201;
        private const int EXIT_LAUNCH = 202;
        private const int EXIT_TIMEOUT = 124;

        private static JavaScriptSerializer Serializer = new JavaScriptSerializer();

        private static int Main(string[] args)
        {
            try
            {
                if (args != null && args.Length >= 2 && String.Equals(args[0], "--grant-null", StringComparison.OrdinalIgnoreCase))
                {
                    for (int i = 1; i < args.Length; i++)
                    {
                        ValidateProfileName(args[i]);
                        IntPtr sid = CreateOrDeriveSid(args[i]);
                        try
                        {
                            AllowNullDevice(sid);
                            Console.Out.WriteLine("grant_null=ok profile=" + args[i] + " sid=" + SidToString(sid));
                        }
                        finally
                        {
                            if (sid != IntPtr.Zero) Native.FreeSid(sid);
                        }
                    }
                    return 0;
                }
                if (args != null && args.Length >= 3 && String.Equals(args[0], "--grant-traverse", StringComparison.OrdinalIgnoreCase))
                {
                    string profileName = args[1];
                    ValidateProfileName(profileName);
                    IntPtr sid = CreateOrDeriveSid(profileName);
                    try
                    {
                        for (int i = 2; i < args.Length; i++)
                        {
                            string ancestor = Path.GetFullPath(args[i]);
                            if (!Directory.Exists(ancestor))
                                throw new DirectoryNotFoundException("traverse ancestor does not exist: " + ancestor);
                            MergeNamedAcl(
                                ancestor,
                                sid,
                                Native.FILE_TRAVERSE | Native.FILE_READ_ATTRIBUTES | Native.SYNCHRONIZE,
                                Native.SET_ACCESS,
                                Native.NO_INHERITANCE);
                            Console.Out.WriteLine("grant_traverse=ok profile=" + profileName + " path=" + ancestor);
                        }
                    }
                    finally
                    {
                        if (sid != IntPtr.Zero) Native.FreeSid(sid);
                    }
                    return 0;
                }
                if (args != null && args.Length >= 3 && String.Equals(args[0], "--grant-exec", StringComparison.OrdinalIgnoreCase))
                {
                    string profileName = args[1];
                    ValidateProfileName(profileName);
                    IntPtr sid = CreateOrDeriveSid(profileName);
                    try
                    {
                        uint rights = (uint)(FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize);
                        for (int i = 2; i < args.Length; i++)
                        {
                            string execRoot = Path.GetFullPath(args[i]);
                            if (!Directory.Exists(execRoot))
                                throw new DirectoryNotFoundException("exec root does not exist: " + execRoot);
                            MergeNamedAcl(
                                execRoot,
                                sid,
                                rights,
                                Native.SET_ACCESS,
                                Native.SUB_CONTAINERS_AND_OBJECTS_INHERIT);
                            Console.Out.WriteLine("grant_exec=ok profile=" + profileName + " path=" + execRoot);
                        }
                    }
                    finally
                    {
                        if (sid != IntPtr.Zero) Native.FreeSid(sid);
                    }
                    return 0;
                }
                if (args != null && args.Length >= 3 && String.Equals(args[0], "--revoke-exec", StringComparison.OrdinalIgnoreCase))
                {
                    string profileName = args[1];
                    ValidateProfileName(profileName);
                    IntPtr sid = CreateOrDeriveSid(profileName);
                    try
                    {
                        string sidString = SidToString(sid);
                        for (int i = 2; i < args.Length; i++)
                        {
                            string execRoot = Path.GetFullPath(args[i]);
                            if (!Directory.Exists(execRoot)) continue;
                            RemoveRootsAcl(sidString, new string[] { execRoot });
                            Console.Out.WriteLine("revoke_exec=ok profile=" + profileName + " path=" + execRoot);
                        }
                    }
                    finally
                    {
                        if (sid != IntPtr.Zero) Native.FreeSid(sid);
                    }
                    return 0;
                }
                string input = Console.In.ReadToEnd();
                if (String.IsNullOrWhiteSpace(input))
                {
                    return Fail("missing JSON request on stdin", EXIT_USAGE, 0);
                }
                BrokerRequest request = Serializer.Deserialize<BrokerRequest>(input);
                if (request == null || String.IsNullOrWhiteSpace(request.operation))
                {
                    return Fail("request.operation is required", EXIT_USAGE, 0);
                }

                string op = request.operation.Trim().ToLowerInvariant();
                if (op == "prepare")
                {
                    using (AppContainerIdentity identity = PrepareIdentity(request))
                    {
                        WriteResponse(new BrokerResponse
                        {
                            ok = true,
                            operation = "prepare",
                            backend = "windows_appcontainer",
                            profileName = identity.Name,
                            sid = identity.SidString,
                            profilePath = identity.ProfilePath
                        });
                    }
                    return 0;
                }
                if (op == "identity")
                {
                    // Non-mutating startup fast path. Report the already-prepared
                    // AppContainer identity without touching filesystem ACLs.
                    using (AppContainerIdentity identity = OpenIdentity(request.profileName))
                    {
                        WriteResponse(new BrokerResponse
                        {
                            ok = true,
                            operation = "identity",
                            backend = "windows_appcontainer",
                            profileName = identity.Name,
                            sid = identity.SidString,
                            profilePath = identity.ProfilePath
                        });
                    }
                    return 0;
                }
                if (op == "cleanup")
                {
                    using (AppContainerIdentity identity = OpenIdentity(request.profileName))
                    {
                        RemoveRootsAcl(identity.SidString, request.removeRoots);
                        RemoveRootsAcl(identity.SidString, request.rwRoots);
                        RemoveRootsAcl(identity.SidString, request.rxRoots);
                    }
                    int hr = Native.DeleteAppContainerProfile(request.profileName);
                    if (hr < 0)
                    {
                        return Fail("DeleteAppContainerProfile failed", EXIT_PREPARE, hr);
                    }
                    WriteResponse(new BrokerResponse
                    {
                        ok = true,
                        operation = "cleanup",
                        backend = "windows_appcontainer",
                        profileName = request.profileName
                    });
                    return 0;
                }
                if (op == "revoke")
                {
                    using (AppContainerIdentity identity = OpenIdentity(request.profileName))
                    {
                        RemoveRootsAcl(identity.SidString, request.removeRoots);
                        RemoveRootsAcl(identity.SidString, request.rwRoots);
                        RemoveRootsAcl(identity.SidString, request.rxRoots);
                    }
                    WriteResponse(new BrokerResponse
                    {
                        ok = true,
                        operation = "revoke",
                        backend = "windows_appcontainer",
                        profileName = request.profileName
                    });
                    return 0;
                }
                if (op == "run")
                {
                    return RunSandboxed(request);
                }
                return Fail("unsupported operation: " + request.operation, EXIT_USAGE, 0);
            }
            catch (Exception ex)
            {
                return Fail(ex.GetType().Name + ": " + ex.Message, EXIT_LAUNCH, Marshal.GetLastWin32Error());
            }
        }

        private static void ValidateProfileName(string name)
        {
            if (String.IsNullOrWhiteSpace(name) || name.Length > 64)
            {
                throw new InvalidOperationException("invalid AppContainer profile name");
            }
            for (int i = 0; i < name.Length; i++)
            {
                char ch = name[i];
                bool ok = Char.IsLetterOrDigit(ch) || ch == '-' || ch == '_' || ch == '.' || ch == ' ';
                if (!ok) throw new InvalidOperationException("invalid AppContainer profile name character");
            }
        }

        private static AppContainerIdentity PrepareIdentity(BrokerRequest request)
        {
            ValidateProfileName(request.profileName);
            IntPtr sid = CreateOrDeriveSid(request.profileName);

            AppContainerIdentity identity = new AppContainerIdentity();
            identity.Name = request.profileName;
            identity.Sid = sid;
            identity.SidString = SidToString(sid);
            identity.ProfilePath = GetProfilePath(identity.SidString);
            EnsureProfileDirectories(identity.ProfilePath);

            // Exact-policy reconciliation. Purge only this AppContainer SID on
            // the known old/current roots; preserve every unrelated DACL entry.
            RemoveRootsAcl(identity.SidString, request.removeRoots);
            RemoveRootsAcl(identity.SidString, request.rwRoots);
            ApplyRootsAcl(identity.SidString, request.rwRoots, true);
            // Read/execute toolchain roots may live under protected locations
            // such as Program Files. They are granted only by the explicit
            // setup command (--grant-exec), never by a medium-integrity runtime
            // process. Runtime merely carries them into PATH/policy metadata.
            // NUL kernel-object ACL compatibility is intentionally not applied
            // here: an unelevated broker cannot assume WRITE_DAC on NUL. The
            // helper retains AllowNullDevice() for an explicit privileged setup
            // phase; ordinary sandbox preparation must not elevate or broaden.
            return identity;
        }

        private static IntPtr CreateOrDeriveSid(string profileName)
        {
            ValidateProfileName(profileName);
            IntPtr sid;
            int hr = Native.CreateAppContainerProfile(
                profileName,
                "ChatGPT Local Coder Sandbox",
                "OS-enforced sandbox for ChatGPT Local Coder agent-triggered processes",
                IntPtr.Zero,
                0,
                out sid);
            if (hr >= 0 && sid != IntPtr.Zero) return sid;

            int win32 = hr & 0xFFFF;
            if (win32 != Native.ERROR_ALREADY_EXISTS)
            {
                throw new InvalidOperationException("CreateAppContainerProfile failed HRESULT=0x" + ((uint)hr).ToString("X8"));
            }
            hr = Native.DeriveAppContainerSidFromAppContainerName(profileName, out sid);
            if (hr < 0 || sid == IntPtr.Zero)
            {
                throw new InvalidOperationException("DeriveAppContainerSidFromAppContainerName failed HRESULT=0x" + ((uint)hr).ToString("X8"));
            }
            return sid;
        }

        private static AppContainerIdentity OpenIdentity(string profileName)
        {
            ValidateProfileName(profileName);
            IntPtr sid;
            int hr = Native.DeriveAppContainerSidFromAppContainerName(profileName, out sid);
            if (hr < 0 || sid == IntPtr.Zero)
            {
                throw new InvalidOperationException(
                    "AppContainer profile is not prepared; DeriveAppContainerSidFromAppContainerName failed HRESULT=0x" +
                    ((uint)hr).ToString("X8"));
            }
            AppContainerIdentity identity = new AppContainerIdentity();
            identity.Name = profileName;
            identity.Sid = sid;
            identity.SidString = SidToString(sid);
            identity.ProfilePath = GetProfilePath(identity.SidString);
            return identity;
        }

        private static string SidToString(IntPtr sid)
        {
            IntPtr ptr;
            if (!Native.ConvertSidToStringSid(sid, out ptr))
            {
                throw new InvalidOperationException("ConvertSidToStringSid failed: " + Marshal.GetLastWin32Error());
            }
            try
            {
                return Marshal.PtrToStringUni(ptr);
            }
            finally
            {
                Native.LocalFree(ptr);
            }
        }

        private static string GetProfilePath(string sidString)
        {
            IntPtr ptr;
            int hr = Native.GetAppContainerFolderPath(sidString, out ptr);
            if (hr < 0 || ptr == IntPtr.Zero)
            {
                throw new InvalidOperationException("GetAppContainerFolderPath failed HRESULT=0x" + ((uint)hr).ToString("X8"));
            }
            try
            {
                return Marshal.PtrToStringUni(ptr);
            }
            finally
            {
                Marshal.FreeCoTaskMem(ptr);
            }
        }

        private static void EnsureProfileDirectories(string profilePath)
        {
            if (String.IsNullOrWhiteSpace(profilePath)) return;
            Directory.CreateDirectory(profilePath);
            Directory.CreateDirectory(Path.Combine(profilePath, "Temp"));
            Directory.CreateDirectory(Path.Combine(profilePath, "Home"));
            Directory.CreateDirectory(Path.Combine(profilePath, "AppData", "Roaming"));
            Directory.CreateDirectory(Path.Combine(profilePath, "AppData", "Local"));
        }

        private static void ApplyRootsAcl(string sidString, string[] roots, bool readWrite)
        {
            if (roots == null) return;
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            IntPtr sid = IntPtr.Zero;
            if (!Native.ConvertStringSidToSid(sidString, out sid) || sid == IntPtr.Zero)
                throw new InvalidOperationException("OS_SANDBOX_ACL_FAILED: invalid sandbox SID " + sidString);
            try
            {
            for (int i = 0; i < roots.Length; i++)
            {
                string raw = roots[i];
                if (String.IsNullOrWhiteSpace(raw)) continue;
                string root = Path.GetFullPath(raw);
                if (!seen.Add(root)) continue;
                if (!Directory.Exists(root))
                {
                    throw new DirectoryNotFoundException("sandbox ACL root does not exist: " + root);
                }
                uint rights = readWrite
                    ? (uint)(System.Security.AccessControl.FileSystemRights.Modify |
                             System.Security.AccessControl.FileSystemRights.ReadAndExecute |
                             System.Security.AccessControl.FileSystemRights.Synchronize)
                    : (uint)(System.Security.AccessControl.FileSystemRights.ReadAndExecute |
                             System.Security.AccessControl.FileSystemRights.Synchronize);
                MergeNamedAcl(root, sid, rights, Native.SET_ACCESS, Native.SUB_CONTAINERS_AND_OBJECTS_INHERIT);
            }
            }
            finally
            {
                Native.LocalFree(sid);
            }
        }

        private static void RemoveRootsAcl(string sidString, string[] roots)
        {
            if (roots == null) return;
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            IntPtr sid = IntPtr.Zero;
            if (!Native.ConvertStringSidToSid(sidString, out sid) || sid == IntPtr.Zero)
                throw new InvalidOperationException("OS_SANDBOX_ACL_FAILED: invalid sandbox SID " + sidString);
            try
            {
            for (int i = 0; i < roots.Length; i++)
            {
                string raw = roots[i];
                if (String.IsNullOrWhiteSpace(raw)) continue;
                string root = Path.GetFullPath(raw);
                if (!seen.Add(root) || !Directory.Exists(root)) continue;
                try
                {
                    MergeNamedAcl(root, sid, 0, Native.REVOKE_ACCESS, Native.SUB_CONTAINERS_AND_OBJECTS_INHERIT);
                }
                catch (Exception ex)
                {
                    throw new InvalidOperationException(
                        "OS_SANDBOX_ACL_FAILED: could not reconcile sandbox ACE on " + root + ": " + ex.Message);
                }
            }
            }
            finally
            {
                Native.LocalFree(sid);
            }
        }

        private static void MergeNamedAcl(string root, IntPtr sid, uint permissions, int accessMode, uint inheritance)
        {
            IntPtr oldDacl = IntPtr.Zero;
            IntPtr securityDescriptor = IntPtr.Zero;
            IntPtr newDacl = IntPtr.Zero;
            uint error = Native.GetNamedSecurityInfo(
                root,
                Native.SE_FILE_OBJECT,
                Native.DACL_SECURITY_INFORMATION,
                IntPtr.Zero,
                IntPtr.Zero,
                out oldDacl,
                IntPtr.Zero,
                out securityDescriptor);
            if (error != 0)
            {
                throw new InvalidOperationException(
                    "OS_SANDBOX_ACL_FAILED: GetNamedSecurityInfo failed for " + root + " Win32=" + error);
            }
            try
            {
                Native.EXPLICIT_ACCESS_W entry = new Native.EXPLICIT_ACCESS_W();
                entry.grfAccessPermissions = permissions;
                entry.grfAccessMode = accessMode;
                entry.grfInheritance = inheritance;
                entry.Trustee = new Native.TRUSTEE_W();
                entry.Trustee.pMultipleTrustee = IntPtr.Zero;
                entry.Trustee.MultipleTrusteeOperation = 0;
                entry.Trustee.TrusteeForm = Native.TRUSTEE_IS_SID;
                entry.Trustee.TrusteeType = Native.TRUSTEE_IS_UNKNOWN;
                entry.Trustee.ptstrName = sid;

                error = Native.SetEntriesInAcl(1, ref entry, oldDacl, out newDacl);
                if (error != 0 || newDacl == IntPtr.Zero)
                {
                    throw new InvalidOperationException(
                        "OS_SANDBOX_ACL_FAILED: SetEntriesInAcl failed for " + root + " Win32=" + error);
                }

                // SetNamedSecurityInfo is deliberately used rather than only
                // setting the parent DirectorySecurity object: Windows applies
                // the inheritable ACE change to existing descendants while
                // preserving protected DACLs and unrelated explicit ACEs.
                error = Native.SetNamedSecurityInfo(
                    root,
                    Native.SE_FILE_OBJECT,
                    Native.DACL_SECURITY_INFORMATION,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    newDacl,
                    IntPtr.Zero);
                if (error != 0)
                {
                    throw new InvalidOperationException(
                        "OS_SANDBOX_ACL_FAILED: SetNamedSecurityInfo failed for " + root + " Win32=" + error);
                }
            }
            finally
            {
                if (newDacl != IntPtr.Zero) Native.LocalFree(newDacl);
                if (securityDescriptor != IntPtr.Zero) Native.LocalFree(securityDescriptor);
            }
        }

        private static void AllowNullDevice(IntPtr sandboxSid)
        {
            // Git for Windows/MSYS and ordinary Win32 redirection may open the
            // NUL kernel object even when the executable and workspace are
            // otherwise accessible. Grant only this AppContainer SID generic
            // read/write/execute on NUL. This is a kernel-object compatibility
            // grant, not a filesystem-root grant.
            IntPtr invalidHandle = new IntPtr(-1);
            IntPtr handle = Native.CreateFile(
                @"\\.\NUL",
                Native.READ_CONTROL | Native.WRITE_DAC,
                Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE,
                IntPtr.Zero,
                Native.OPEN_EXISTING,
                Native.FILE_ATTRIBUTE_NORMAL,
                IntPtr.Zero);
            if (handle == IntPtr.Zero || handle == invalidHandle)
            {
                throw new InvalidOperationException(
                    "OS_SANDBOX_ACL_FAILED: opening NUL for ACL write failed Win32=" + Marshal.GetLastWin32Error());
            }

            IntPtr oldDacl = IntPtr.Zero;
            IntPtr securityDescriptor = IntPtr.Zero;
            IntPtr newDacl = IntPtr.Zero;
            try
            {
                uint error = Native.GetSecurityInfo(
                    handle,
                    Native.SE_KERNEL_OBJECT,
                    Native.DACL_SECURITY_INFORMATION,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    out oldDacl,
                    IntPtr.Zero,
                    out securityDescriptor);
                if (error != 0)
                {
                    throw new InvalidOperationException(
                        "OS_SANDBOX_ACL_FAILED: GetSecurityInfo(NUL) failed Win32=" + error);
                }

                Native.EXPLICIT_ACCESS_W entry = new Native.EXPLICIT_ACCESS_W();
                entry.grfAccessPermissions =
                    Native.FILE_GENERIC_READ | Native.FILE_GENERIC_WRITE | Native.FILE_GENERIC_EXECUTE;
                entry.grfAccessMode = Native.SET_ACCESS;
                entry.grfInheritance = Native.NO_INHERITANCE;
                entry.Trustee = new Native.TRUSTEE_W();
                entry.Trustee.pMultipleTrustee = IntPtr.Zero;
                entry.Trustee.MultipleTrusteeOperation = 0;
                entry.Trustee.TrusteeForm = Native.TRUSTEE_IS_SID;
                entry.Trustee.TrusteeType = Native.TRUSTEE_IS_UNKNOWN;
                entry.Trustee.ptstrName = sandboxSid;

                error = Native.SetEntriesInAcl(1, ref entry, oldDacl, out newDacl);
                if (error != 0 || newDacl == IntPtr.Zero)
                {
                    throw new InvalidOperationException(
                        "OS_SANDBOX_ACL_FAILED: SetEntriesInAcl(NUL) failed Win32=" + error);
                }

                error = Native.SetSecurityInfo(
                    handle,
                    Native.SE_KERNEL_OBJECT,
                    Native.DACL_SECURITY_INFORMATION,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    newDacl,
                    IntPtr.Zero);
                if (error != 0)
                {
                    throw new InvalidOperationException(
                        "OS_SANDBOX_ACL_FAILED: SetSecurityInfo(NUL) failed Win32=" + error);
                }
            }
            finally
            {
                if (newDacl != IntPtr.Zero) Native.LocalFree(newDacl);
                if (securityDescriptor != IntPtr.Zero) Native.LocalFree(securityDescriptor);
                Native.CloseHandle(handle);
            }
        }

        private static int RunSandboxed(BrokerRequest request)
        {
            if (String.IsNullOrWhiteSpace(request.executable)) return Fail("request.executable is required", EXIT_USAGE, 0);
            if (String.IsNullOrWhiteSpace(request.cwd)) return Fail("request.cwd is required", EXIT_USAGE, 0);
            if (!File.Exists(request.executable)) return Fail("executable not found: " + request.executable, EXIT_LAUNCH, 2);
            if (!Directory.Exists(request.cwd)) return Fail("cwd not found: " + request.cwd, EXIT_LAUNCH, 3);

            // ACL preparation is an explicit startup/config-change operation.
            // The hot run path only opens the existing identity: it must never
            // broaden filesystem grants on behalf of an agent command.
            using (AppContainerIdentity identity = OpenIdentity(request.profileName))
            {
                return LaunchInAppContainer(identity, request);
            }
        }

        private static int LaunchInAppContainer(AppContainerIdentity identity, BrokerRequest request)
        {
            IntPtr stdoutRead = IntPtr.Zero;
            IntPtr stdoutWrite = IntPtr.Zero;
            IntPtr stderrRead = IntPtr.Zero;
            IntPtr stderrWrite = IntPtr.Zero;
            IntPtr stdinRead = IntPtr.Zero;
            IntPtr stdinWrite = IntPtr.Zero;
            IntPtr attrList = IntPtr.Zero;
            IntPtr securityCapabilitiesPtr = IntPtr.Zero;
            IntPtr handleListPtr = IntPtr.Zero;
            IntPtr capabilityArrayPtr = IntPtr.Zero;
            IntPtr capabilitySid = IntPtr.Zero;
            IntPtr environmentPtr = IntPtr.Zero;
            IntPtr job = IntPtr.Zero;
            Native.PROCESS_INFORMATION processInfo = new Native.PROCESS_INFORMATION();
            Thread stdoutPump = null;
            Thread stderrPump = null;

            try
            {
                Native.SECURITY_ATTRIBUTES sa = new Native.SECURITY_ATTRIBUTES();
                sa.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES));
                sa.lpSecurityDescriptor = IntPtr.Zero;
                sa.bInheritHandle = true;

                CreateParentReadPipe(ref sa, out stdoutRead, out stdoutWrite, "stdout");
                CreateParentReadPipe(ref sa, out stderrRead, out stderrWrite, "stderr");
                if (!Native.CreatePipe(out stdinRead, out stdinWrite, ref sa, 0))
                    throw Win32("CreatePipe(stdin)");
                if (!Native.SetHandleInformation(stdinWrite, Native.HANDLE_FLAG_INHERIT, 0))
                    throw Win32("SetHandleInformation(stdin)");

                IntPtr size = IntPtr.Zero;
                Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
                if (size == IntPtr.Zero) throw Win32("InitializeProcThreadAttributeList(size)");
                attrList = Marshal.AllocHGlobal(size);
                if (!Native.InitializeProcThreadAttributeList(attrList, 2, 0, ref size))
                    throw Win32("InitializeProcThreadAttributeList");

                Native.SECURITY_CAPABILITIES securityCapabilities = BuildSecurityCapabilities(
                    identity.Sid,
                    request.networkMode,
                    out capabilityArrayPtr,
                    out capabilitySid);
                securityCapabilitiesPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Native.SECURITY_CAPABILITIES)));
                Marshal.StructureToPtr(securityCapabilities, securityCapabilitiesPtr, false);
                if (!Native.UpdateProcThreadAttribute(
                    attrList,
                    0,
                    Native.PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                    securityCapabilitiesPtr,
                    new IntPtr(Marshal.SizeOf(typeof(Native.SECURITY_CAPABILITIES))),
                    IntPtr.Zero,
                    IntPtr.Zero))
                {
                    throw Win32("UpdateProcThreadAttribute(SECURITY_CAPABILITIES)");
                }

                IntPtr[] childHandles = new IntPtr[] { stdinRead, stdoutWrite, stderrWrite };
                handleListPtr = Marshal.AllocHGlobal(IntPtr.Size * childHandles.Length);
                for (int i = 0; i < childHandles.Length; i++)
                    Marshal.WriteIntPtr(handleListPtr, i * IntPtr.Size, childHandles[i]);
                if (!Native.UpdateProcThreadAttribute(
                    attrList,
                    0,
                    Native.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                    handleListPtr,
                    new IntPtr(IntPtr.Size * childHandles.Length),
                    IntPtr.Zero,
                    IntPtr.Zero))
                {
                    throw Win32("UpdateProcThreadAttribute(HANDLE_LIST)");
                }

                Native.STARTUPINFOEX startup = new Native.STARTUPINFOEX();
                startup.StartupInfo.cb = Marshal.SizeOf(typeof(Native.STARTUPINFOEX));
                startup.StartupInfo.dwFlags = Native.STARTF_USESTDHANDLES;
                startup.StartupInfo.hStdInput = stdinRead;
                startup.StartupInfo.hStdOutput = stdoutWrite;
                startup.StartupInfo.hStdError = stderrWrite;
                startup.lpAttributeList = attrList;

                environmentPtr = BuildEnvironmentBlock(request.env);
                StringBuilder commandLine = new StringBuilder(BuildCommandLine(request.executable, request.args));
                uint flags = Native.EXTENDED_STARTUPINFO_PRESENT |
                             Native.CREATE_UNICODE_ENVIRONMENT |
                             Native.CREATE_SUSPENDED |
                             Native.CREATE_NO_WINDOW;

                if (!Native.CreateProcess(
                    request.executable,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    flags,
                    environmentPtr,
                    request.cwd,
                    ref startup,
                    out processInfo))
                {
                    throw Win32("CreateProcess(AppContainer)");
                }

                job = Native.CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) throw Win32("CreateJobObject");
                ConfigureKillOnClose(job);
                if (!Native.AssignProcessToJobObject(job, processInfo.hProcess))
                {
                    Native.TerminateProcess(processInfo.hProcess, EXIT_LAUNCH);
                    throw Win32("AssignProcessToJobObject");
                }

                if (Native.ResumeThread(processInfo.hThread) == 0xFFFFFFFF)
                {
                    Native.TerminateJobObject(job, EXIT_LAUNCH);
                    throw Win32("ResumeThread");
                }

                // Close broker copies of handles owned by the sandboxed child.
                Close(ref stdinRead);
                Close(ref stdinWrite); // child sees EOF on stdin
                Close(ref stdoutWrite);
                Close(ref stderrWrite);

                stdoutPump = StartPump(stdoutRead, Console.OpenStandardOutput());
                stdoutRead = IntPtr.Zero;
                stderrPump = StartPump(stderrRead, Console.OpenStandardError());
                stderrRead = IntPtr.Zero;

                uint waitMs = request.timeoutMs > 0 ? (uint)request.timeoutMs : Native.INFINITE;
                uint wait = Native.WaitForSingleObject(processInfo.hProcess, waitMs);
                if (wait == Native.WAIT_TIMEOUT)
                {
                    Native.TerminateJobObject(job, EXIT_TIMEOUT);
                    Native.WaitForSingleObject(processInfo.hProcess, 5000);
                    Close(ref job); // kill any descendants, force pipe EOF
                    JoinPump(stdoutPump);
                    JoinPump(stderrPump);
                    return EXIT_TIMEOUT;
                }
                if (wait != 0)
                {
                    Native.TerminateJobObject(job, EXIT_LAUNCH);
                    throw Win32("WaitForSingleObject");
                }

                uint exitCode;
                if (!Native.GetExitCodeProcess(processInfo.hProcess, out exitCode))
                    throw Win32("GetExitCodeProcess");

                // The root process may have left descendants behind. Closing a job with
                // KILL_ON_JOB_CLOSE terminates them before the broker returns.
                Close(ref job);
                JoinPump(stdoutPump);
                JoinPump(stderrPump);
                return unchecked((int)exitCode);
            }
            finally
            {
                if (job != IntPtr.Zero)
                {
                    Native.TerminateJobObject(job, EXIT_LAUNCH);
                    Close(ref job);
                }
                Close(ref processInfo.hThread);
                Close(ref processInfo.hProcess);
                Close(ref stdinRead);
                Close(ref stdinWrite);
                Close(ref stdoutWrite);
                Close(ref stderrWrite);
                Close(ref stdoutRead);
                Close(ref stderrRead);
                if (attrList != IntPtr.Zero)
                {
                    Native.DeleteProcThreadAttributeList(attrList);
                    Marshal.FreeHGlobal(attrList);
                }
                if (securityCapabilitiesPtr != IntPtr.Zero) Marshal.FreeHGlobal(securityCapabilitiesPtr);
                if (handleListPtr != IntPtr.Zero) Marshal.FreeHGlobal(handleListPtr);
                if (capabilityArrayPtr != IntPtr.Zero) Marshal.FreeHGlobal(capabilityArrayPtr);
                if (capabilitySid != IntPtr.Zero) Native.LocalFree(capabilitySid);
                if (environmentPtr != IntPtr.Zero) Marshal.FreeHGlobal(environmentPtr);
            }
        }

        private static void CreateParentReadPipe(
            ref Native.SECURITY_ATTRIBUTES sa,
            out IntPtr read,
            out IntPtr write,
            string label)
        {
            if (!Native.CreatePipe(out read, out write, ref sa, 0)) throw Win32("CreatePipe(" + label + ")");
            if (!Native.SetHandleInformation(read, Native.HANDLE_FLAG_INHERIT, 0))
                throw Win32("SetHandleInformation(" + label + ")");
        }

        private static Native.SECURITY_CAPABILITIES BuildSecurityCapabilities(
            IntPtr appContainerSid,
            string networkMode,
            out IntPtr capabilityArrayPtr,
            out IntPtr capabilitySid)
        {
            capabilityArrayPtr = IntPtr.Zero;
            capabilitySid = IntPtr.Zero;
            string mode = String.IsNullOrWhiteSpace(networkMode) ? "none" : networkMode.Trim().ToLowerInvariant();
            Native.SECURITY_CAPABILITIES result = new Native.SECURITY_CAPABILITIES();
            result.AppContainerSid = appContainerSid;
            result.Capabilities = IntPtr.Zero;
            result.CapabilityCount = 0;
            result.Reserved = 0;
            if (mode == "none") return result;
            if (mode != "internet") throw new InvalidOperationException("unsupported network mode: " + networkMode);

            // SECURITY_CAPABILITY_INTERNET_CLIENT = S-1-15-3-1.
            if (!Native.ConvertStringSidToSid("S-1-15-3-1", out capabilitySid))
                throw Win32("ConvertStringSidToSid(internetClient)");
            Native.SID_AND_ATTRIBUTES item = new Native.SID_AND_ATTRIBUTES();
            item.Sid = capabilitySid;
            item.Attributes = Native.SE_GROUP_ENABLED;
            capabilityArrayPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Native.SID_AND_ATTRIBUTES)));
            Marshal.StructureToPtr(item, capabilityArrayPtr, false);
            result.Capabilities = capabilityArrayPtr;
            result.CapabilityCount = 1;
            return result;
        }

        private static void ConfigureKillOnClose(IntPtr job)
        {
            Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                if (!Native.SetInformationJobObject(job, Native.JobObjectExtendedLimitInformation, ptr, (uint)size))
                    throw Win32("SetInformationJobObject(KILL_ON_JOB_CLOSE)");
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
        }

        private static Thread StartPump(IntPtr rawHandle, Stream destination)
        {
            SafeFileHandle safe = new SafeFileHandle(rawHandle, true);
            FileStream source = new FileStream(safe, FileAccess.Read, 4096, false);
            Thread thread = new Thread(delegate()
            {
                try
                {
                    byte[] buffer = new byte[8192];
                    while (true)
                    {
                        int read = source.Read(buffer, 0, buffer.Length);
                        if (read <= 0) break;
                        destination.Write(buffer, 0, read);
                        destination.Flush();
                    }
                }
                catch { }
                finally
                {
                    source.Dispose();
                }
            });
            thread.IsBackground = true;
            thread.Start();
            return thread;
        }

        private static void JoinPump(Thread thread)
        {
            if (thread == null) return;
            thread.Join(5000);
        }

        private static IntPtr BuildEnvironmentBlock(Dictionary<string, string> env)
        {
            SortedDictionary<string, string> sorted = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (env != null)
            {
                foreach (KeyValuePair<string, string> pair in env)
                {
                    if (String.IsNullOrEmpty(pair.Key) || pair.Key.IndexOf('=') >= 0 || pair.Key.IndexOf('\0') >= 0) continue;
                    string value = pair.Value ?? String.Empty;
                    if (value.IndexOf('\0') >= 0) continue;
                    sorted[pair.Key] = value;
                }
            }
            StringBuilder block = new StringBuilder();
            foreach (KeyValuePair<string, string> pair in sorted)
            {
                block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
            }
            block.Append('\0');
            byte[] bytes = Encoding.Unicode.GetBytes(block.ToString());
            IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);
            Marshal.Copy(bytes, 0, ptr, bytes.Length);
            return ptr;
        }

        private static string BuildCommandLine(string executable, string[] args)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append(QuoteWindowsArgument(executable));
            if (args != null)
            {
                for (int i = 0; i < args.Length; i++)
                {
                    sb.Append(' ').Append(QuoteWindowsArgument(args[i] ?? String.Empty));
                }
            }
            return sb.ToString();
        }

        // Windows CRT-compatible quoting. Handles spaces, quotes and trailing
        // backslashes without asking a shell to interpret untrusted arguments.
        private static string QuoteWindowsArgument(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
                return arg;
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            int slashes = 0;
            for (int i = 0; i < arg.Length; i++)
            {
                char ch = arg[i];
                if (ch == '\\')
                {
                    slashes++;
                    continue;
                }
                if (ch == '"')
                {
                    sb.Append('\\', slashes * 2 + 1);
                    sb.Append('"');
                    slashes = 0;
                    continue;
                }
                if (slashes > 0)
                {
                    sb.Append('\\', slashes);
                    slashes = 0;
                }
                sb.Append(ch);
            }
            if (slashes > 0) sb.Append('\\', slashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        private static Exception Win32(string operation)
        {
            int code = Marshal.GetLastWin32Error();
            return new InvalidOperationException(operation + " failed Win32=" + code);
        }

        private static void Close(ref IntPtr handle)
        {
            if (handle == IntPtr.Zero) return;
            Native.CloseHandle(handle);
            handle = IntPtr.Zero;
        }

        private static int Fail(string message, int exitCode, int nativeError)
        {
            BrokerResponse response = new BrokerResponse();
            response.ok = false;
            response.backend = "windows_appcontainer";
            response.error = message;
            response.nativeError = nativeError;
            Console.Error.WriteLine("CLC_SANDBOX_ERROR:" + Serializer.Serialize(response));
            return exitCode;
        }

        private static void WriteResponse(BrokerResponse response)
        {
            Console.Out.WriteLine(Serializer.Serialize(response));
        }
    }
}
