using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

// Reuses the existing WinExe/no-console supervisor pattern. It owns process lifetime,
// not file/network containment. No task or service is registered by this executable.
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2 || !Regex.IsMatch(args[1], "\\A[0-9a-f]{64}\\z")) return 64;
            CheckFile(args[0], args[1]);
            var plan = JsonSerializer.Deserialize<LaunchPlan>(File.ReadAllText(args[0]), new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
            if (plan is null || plan.SchemaVersion != 1 || (plan.Role != "broker" && plan.Role != "hermes") ||
                !Regex.IsMatch(plan.ProfileId, "\\A[a-zA-Z0-9_-]{1,80}\\z") || plan.Arguments.Length == 0 || plan.Arguments.Length > 32) return 64;
            CheckPath(plan.StateDirectory); CheckPath(plan.WorkingDirectory);
            if (File.Exists(Path.Combine(plan.StateDirectory, "STOP")) || File.Exists(Path.Combine(plan.StateDirectory, ".ops.lock")) ||
                File.Exists(Path.Combine(plan.StateDirectory, ".neurobro-reconciliation-required.json"))) return 75;
            CheckFile(plan.Executable.Path, plan.Executable.Sha256);
            if (plan.EvidenceFiles.Length == 0 || plan.EvidenceFiles.Length > 10000) return 64;
            foreach (var file in plan.EvidenceFiles) CheckFile(file.Path, file.Sha256);
            string identity = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Path.GetFullPath(plan.StateDirectory).ToLowerInvariant() + ":" + plan.Role)));
            using var mutex = new Mutex(false, "Local\\NeurobroPersonal-" + identity);
            bool owned;
            try { owned = mutex.WaitOne(0); } catch (AbandonedMutexException) { return 75; }
            if (!owned) return 73;
            try
            {
                using var job = CreateOwnedJob();
                var start = new ProcessStartInfo(plan.Executable.Path) {
                    WorkingDirectory = plan.WorkingDirectory, UseShellExecute = false,
                    CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                    RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true
                };
                foreach (var arg in plan.Arguments) start.ArgumentList.Add(arg);
                start.Environment.Clear();
                foreach (var (name, binding) in plan.Environment)
                {
                    if (!Regex.IsMatch(name, "\\A[A-Za-z_][A-Za-z0-9_]*\\z")) return 64;
                    if ((binding.Literal is null) == (binding.FromEnvironment is null)) return 64;
                    string? value = binding.Literal;
                    if (binding.FromEnvironment is not null)
                    {
                        if (!Regex.IsMatch(binding.FromEnvironment, "\\ANEUROBRO_[A-Z0-9_]+\\z")) return 64;
                        value = Environment.GetEnvironmentVariable(binding.FromEnvironment);
                        if (String.IsNullOrEmpty(value)) return 78;
                    }
                    if (value is null || value.Contains('\0') || value.Contains('\n') || value.Contains('\r')) return 64;
                    start.Environment[name] = value;
                }
                using var child = Process.Start(start);
                if (child is null) return 70;
                // Job membership is lifecycle control. Same-user filesystem isolation must
                // be supplied separately and proven before unrestricted tools are enabled.
                if (!AssignProcessToJobObject(job, child.Handle)) { child.Kill(entireProcessTree: true); child.WaitForExit(); return 70; }
                Task output = child.StandardOutput.BaseStream.CopyToAsync(Stream.Null);
                Task error = child.StandardError.BaseStream.CopyToAsync(Stream.Null);
                child.StandardInput.Close();
                try
                {
                    child.WaitForExit();
                    bool orphaned = ActiveProcesses(job) != 0;
                    if (orphaned)
                    {
                        if (!TerminateJobObject(job, 80)) return 80;
                        var deadline = Stopwatch.StartNew();
                        while (ActiveProcesses(job) != 0 && deadline.Elapsed < TimeSpan.FromSeconds(10)) Thread.Sleep(25);
                        if (ActiveProcesses(job) != 0) return 80;
                    }
                    if (!Task.WaitAll([output, error], TimeSpan.FromSeconds(10))) return 80;
                    // An orphan termination is not successful application settlement.
                    return orphaned ? 80 : child.ExitCode;
                }
                finally { if (!child.HasExited) { child.Kill(entireProcessTree: true); child.WaitForExit(); } }
            }
            finally { mutex.ReleaseMutex(); }
        }
        catch { return 70; } // Deliberately never prints config, environment, or raw exceptions.
    }
    private static void CheckFile(string path, string hash)
    {
        CheckPath(path);
        if (!Regex.IsMatch(hash, "\\A[0-9a-f]{64}\\z") || !File.Exists(path)) throw new InvalidDataException();
        using var file = File.OpenRead(path);
        if (Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant() != hash) throw new InvalidDataException();
    }
    private static void CheckPath(string path)
    {
        if (!Path.IsPathFullyQualified(path)) throw new InvalidDataException();
        for (string? current = Path.GetFullPath(path); current is not null; current = Path.GetDirectoryName(current))
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException();
    }
    private static SafeFileHandle CreateOwnedJob()
    {
        var job = CreateJobObject(IntPtr.Zero, null);
        if (job.IsInvalid) throw new InvalidOperationException();
        var info = new ExtendedLimit { BasicLimitInformation = new BasicLimit { LimitFlags = 0x00002000 } }; // KILL_ON_JOB_CLOSE, no breakaway.
        int size = Marshal.SizeOf<ExtendedLimit>(); IntPtr buffer = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(info, buffer, false); if (!SetInformationJobObject(job, 9, buffer, (uint)size)) { job.Dispose(); throw new InvalidOperationException(); } }
        finally { Marshal.FreeHGlobal(buffer); }
        return job;
    }
    private static uint ActiveProcesses(SafeFileHandle job)
    {
        int size = Marshal.SizeOf<BasicAccounting>(); IntPtr buffer = Marshal.AllocHGlobal(size);
        try { if (!QueryInformationJobObject(job, 1, buffer, (uint)size, IntPtr.Zero)) throw new InvalidOperationException(); return Marshal.PtrToStructure<BasicAccounting>(buffer).ActiveProcesses; }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    [StructLayout(LayoutKind.Sequential)] private struct BasicAccounting { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimit { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimit { public BasicLimit BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(SafeFileHandle job, int infoClass, IntPtr info, uint length, IntPtr returnedLength);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
    private sealed class LaunchPlan { public int SchemaVersion { get; set; } public string Role { get; set; } = ""; public string ProfileId { get; set; } = ""; public string StateDirectory { get; set; } = ""; public string WorkingDirectory { get; set; } = ""; public Binary Executable { get; set; } = new(); public string[] Arguments { get; set; } = []; public Binary[] EvidenceFiles { get; set; } = []; public Dictionary<string, EnvironmentBinding> Environment { get; set; } = []; }
    private sealed class Binary { public string Path { get; set; } = ""; public string Sha256 { get; set; } = ""; }
    private sealed class EnvironmentBinding { public string? Literal { get; set; } public string? FromEnvironment { get; set; } }
}
