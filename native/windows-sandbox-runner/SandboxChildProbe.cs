using System;
using System.IO;

namespace ChatGptLocalCoder.SandboxRunner
{
    internal static class SandboxChildProbe
    {
        private static int Main(string[] args)
        {
            if (args.Length != 3)
            {
                Console.Error.WriteLine("usage: SandboxChildProbe <inside-marker> <outside-read> <outside-write>");
                return 64;
            }

            string insideMarker = args[0];
            string outsideRead = args[1];
            string outsideWrite = args[2];
            try
            {
                File.WriteAllText(insideMarker, "child-ok");
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("inside_write=failed type=" + ex.GetType().Name);
                return 10;
            }

            bool readDenied = false;
            bool writeDenied = false;
            try
            {
                File.ReadAllText(outsideRead);
                Console.WriteLine("outside_read=escape");
            }
            catch (UnauthorizedAccessException)
            {
                readDenied = true;
                Console.WriteLine("outside_read=denied");
            }
            catch (Exception ex)
            {
                Console.WriteLine("outside_read=error:" + ex.GetType().Name);
            }

            try
            {
                File.WriteAllText(outsideWrite, "escape");
                Console.WriteLine("outside_write=escape");
            }
            catch (UnauthorizedAccessException)
            {
                writeDenied = true;
                Console.WriteLine("outside_write=denied");
            }
            catch (Exception ex)
            {
                Console.WriteLine("outside_write=error:" + ex.GetType().Name);
            }

            return readDenied && writeDenied ? 0 : 11;
        }
    }
}
