using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

// GUI-subsystem supervisor: no console is allocated for this or the child.
// It remains alive until the exact Node worker and its output streams settle.
internal static class NeurobroBackground
{
    private const string Node = @"C:\Program Files\DecadansNeurobro\node.exe";
    private const string NodeHash = "3331e1ffe19874215472217c5e94f5a0c6d8e18c4ac7111d3937aa0ad5e9b4a5";
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || !Regex.IsMatch(args[0], @"\AC:\\Neurobro\\build\z") ||
                !Regex.IsMatch(args[1], @"\A[0-9a-f]{64}\z")) return 64;
            string host = Path.Combine(args[0], "standing-host.mjs");
            if (!File.Exists(host) || !File.Exists(Node)) return 66;
            using (var hash = SHA256.Create())
            using (var file = File.OpenRead(Node))
                if (BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant() != NodeHash) return 66;
            var info = new ProcessStartInfo(Node, "\"" + host + "\" --run " + args[1]);
            info.WorkingDirectory = args[0];
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.RedirectStandardInput = true;
            info.EnvironmentVariables.Clear();
            info.EnvironmentVariables["SystemRoot"] = @"C:\Windows";
            info.EnvironmentVariables["WINDIR"] = @"C:\Windows";
            info.EnvironmentVariables["PATH"] = @"C:\Windows\System32";
            info.EnvironmentVariables["LOCALAPPDATA"] = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            info.EnvironmentVariables["USERPROFILE"] = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            using (var child = Process.Start(info))
            {
                Task output = null, error = null;
                try
                {
                    output = child.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
                    error = child.StandardError.BaseStream.CopyToAsync(Stream.Null);
                    child.StandardInput.Close();
                    child.WaitForExit();
                    Task.WaitAll(output, error);
                    return child.ExitCode;
                }
                finally
                {
                    // Do not report the task finished while an owned child survives.
                    if (!child.HasExited)
                    {
                        try { child.Kill(); } catch { }
                        child.WaitForExit();
                    }
                    if (output != null) { try { output.Wait(); } catch { } }
                    if (error != null) { try { error.Wait(); } catch { } }
                }
            }
        }
        catch { return 1; }
    }
}
