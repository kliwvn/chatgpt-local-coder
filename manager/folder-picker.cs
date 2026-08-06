// folder-picker.cs — modern Windows folder dialog (IFileDialog with
// FOS_PICKFOLDERS — the same Explorer "Select Folder" dialog VS Code uses).
// Compiled once by the manager with csc.exe (.NET Framework, ships with
// Windows); runs in ~200ms (no PowerShell).
//
// Build:  csc /nologo /target:exe /out:folder-picker.exe folder-picker.cs
// Usage:  FOLDER_PICKER_INITIAL=<dir> folder-picker.exe
// Exit:   0 = picked, path on stdout | 1 = cancelled | other = error
using System;
using System.IO;
using System.Runtime.InteropServices;

class FolderPicker
{
    const uint FOS_PICKFOLDERS = 0x00000020;
    const uint FOS_FORCEFILESYSTEM = 0x00000040;
    const uint FOS_PATHMUSTEXIST = 0x00000800;
    const int SIGDN_FILESYSPATH = unchecked((int)0x80058000);
    // HRESULT_FROM_WIN32(ERROR_CANCELLED)
    const int HR_CANCELLED = unchecked((int)0x800704C7);

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHCreateItemFromParsingName(
        string pszPath, IntPtr pbc, ref Guid riid, out IShellItem ppv);

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialogRCW { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        [PreserveSig] int SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        [PreserveSig] int SetFileTypeIndex(uint iFileType);
        [PreserveSig] int GetFileTypeIndex(out uint piFileType);
        [PreserveSig] int Advise(IntPtr pfde, out uint pdwCookie);
        [PreserveSig] int Unadvise(uint dwCookie);
        [PreserveSig] int SetOptions(uint fos);
        [PreserveSig] int GetOptions(out uint pfos);
        [PreserveSig] int SetDefaultFolder(IShellItem psi);
        [PreserveSig] int SetFolder(IShellItem psi);
        [PreserveSig] int GetFolder(out IShellItem ppsi);
        [PreserveSig] int GetCurrentSelection(out IShellItem ppsi);
        [PreserveSig] int SetFileName(string pszName);
        [PreserveSig] int GetFileName(out string pszName);
        [PreserveSig] int SetTitle(string pszTitle);
        [PreserveSig] int SetOkButtonLabel(string pszText);
        [PreserveSig] int SetFileNameLabel(string pszLabel);
        [PreserveSig] int GetResult(out IShellItem ppsi);
        [PreserveSig] int AddPlace(IShellItem psi, int fdap);
        [PreserveSig] int SetDefaultExtension(string pszDefaultExtension);
        [PreserveSig] int Close(int hr);
        [PreserveSig] int SetClientGuid(ref Guid guid);
        [PreserveSig] int ClearClientData();
        [PreserveSig] int SetFilter(IntPtr pFilter);
        [PreserveSig] int GetResults(out IntPtr ppenum);
        [PreserveSig] int GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetParent(out IShellItem ppsi);
        [PreserveSig] int GetDisplayName(int sigdnName, out string ppszName);
        [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
    }

    static Guid IID_IShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

    [STAThread]
    static int Main()
    {
        string initial = Environment.GetEnvironmentVariable("FOLDER_PICKER_INITIAL");
        try
        {
            var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            dialog.SetTitle("Chọn thư mục workspace");

            if (!string.IsNullOrEmpty(initial) && Directory.Exists(initial))
            {
                IShellItem folder;
                if (SHCreateItemFromParsingName(initial, IntPtr.Zero, ref IID_IShellItem, out folder) == 0)
                {
                    dialog.SetFolder(folder);
                }
            }

            int hr = dialog.Show(IntPtr.Zero); // top-level, không phụ thuộc parent
            if (hr != 0)
            {
                Console.Error.WriteLine("SHOW_HRESULT: 0x" + hr.ToString("X8"));
                return hr == HR_CANCELLED ? 1 : hr; // cancelled = 1
            }

            IShellItem result;
            if (dialog.GetResult(out result) != 0)
            {
                return 1;
            }
            string path;
            if (result.GetDisplayName(SIGDN_FILESYSPATH, out path) != 0 ||
                string.IsNullOrEmpty(path))
            {
                return 1;
            }
            Console.WriteLine(path);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("FOLDER_PICKER_ERROR: " + ex.Message);
            return 2;
        }
    }
}
