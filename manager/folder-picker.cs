// folder-picker.cs — native modern Windows folder dialog (IFileDialog via
// OpenFileDialog folder-selection trick). Compiled once by the manager with
// csc.exe (.NET Framework, ships with Windows); runs in ~200ms (no PowerShell).
//
// Build:  csc /nologo /target:exe /out:folder-picker.exe folder-picker.cs
// Usage:  FOLDER_PICKER_INITIAL=<dir> folder-picker.exe
// Exit:   0 = picked, path on stdout | 1 = cancelled | other = error
using System;
using System.IO;
using System.Windows.Forms;

class FolderPicker
{
    [STAThread]
    static int Main()
    {
        string initial = Environment.GetEnvironmentVariable("FOLDER_PICKER_INITIAL");
        using (var dlg = new OpenFileDialog())
        {
            dlg.Title = "Chọn thư mục workspace";
            // Classic trick: OpenFileDialog in "select folder" mode shows the
            // modern Explorer-style dialog and returns the folder path.
            dlg.ValidateNames = false;
            dlg.CheckFileExists = false;
            dlg.CheckPathExists = true;
            dlg.FileName = "Chọn thư mục";
            if (!string.IsNullOrEmpty(initial) && Directory.Exists(initial))
            {
                dlg.InitialDirectory = initial;
            }
            if (dlg.ShowDialog() == DialogResult.OK)
            {
                string path = Path.GetDirectoryName(dlg.FileName);
                if (!string.IsNullOrEmpty(path))
                {
                    Console.WriteLine(path);
                    return 0;
                }
            }
            return 1; // cancelled
        }
    }
}
