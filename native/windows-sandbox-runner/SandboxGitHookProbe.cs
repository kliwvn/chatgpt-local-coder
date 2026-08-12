using System;
using System.IO;

namespace ChatGptLocalCoder.SandboxRunner
{
    internal static class SandboxGitHookProbe
    {
        private static int Main(string[] args)
        {
            string inside = Environment.GetEnvironmentVariable("CLC_HOOK_INSIDE");
            string outsideRead = Environment.GetEnvironmentVariable("CLC_HOOK_OUTSIDE_READ");
            string outsideWrite = Environment.GetEnvironmentVariable("CLC_HOOK_OUTSIDE_WRITE");
            string output = Environment.GetEnvironmentVariable("CLC_HOOK_OUTPUT");
            if (String.IsNullOrWhiteSpace(inside) || String.IsNullOrWhiteSpace(outsideRead) ||
                String.IsNullOrWhiteSpace(outsideWrite) || String.IsNullOrWhiteSpace(output))
            {
                return 64;
            }

            File.WriteAllText(inside, "hook-child-ok");
            string read = "error";
            string write = "error";
            try { File.ReadAllText(outsideRead); read = "escape"; }
            catch (UnauthorizedAccessException) { read = "denied"; }
            catch (Exception ex) { read = "error:" + ex.GetType().Name; }

            try { File.WriteAllText(outsideWrite, "escape"); write = "escape"; }
            catch (UnauthorizedAccessException) { write = "denied"; }
            catch (Exception ex) { write = "error:" + ex.GetType().Name; }

            File.WriteAllText(output, "outside_read=" + read + Environment.NewLine + "outside_write=" + write + Environment.NewLine);
            return read == "denied" && write == "denied" ? 0 : 65;
        }
    }
}
