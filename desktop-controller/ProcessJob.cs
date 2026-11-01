using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace MovieStream.Controller
{
    public sealed class ProcessJob : IDisposable
    {
        private const uint CreateSuspended = 0x00000004;
        private const uint CreateNoWindow = 0x08000000;
        private const uint ExtendedStartupInfoPresent = 0x00080000;
        private const uint StartfUseStdHandles = 0x00000100;
        private const uint HandleFlagInherit = 0x00000001;
        private const uint GenericRead = 0x80000000;
        private const uint FileShareRead = 0x00000001;
        private const uint FileShareWrite = 0x00000002;
        private const uint OpenExisting = 3;
        private const uint FileAttributeNormal = 0x00000080;
        private const uint JobObjectLimitKillOnJobClose = 0x00002000;
        private const uint WaitObject0 = 0;
        private const uint WaitFailed = 0xffffffff;
        private const int JobObjectExtendedLimitInformation = 9;
        private static readonly IntPtr HandleListAttribute = new IntPtr(0x00020002);
        private const int LogCapacity = 500;
        private const int MaxLogLineLength = 4096;

        private readonly object _logLock = new object();
        private readonly Queue<string> _logs = new Queue<string>();
        private SafeFileHandle _job;
        private SafeFileHandle _process;
        private StreamReader _stdout;
        private StreamReader _stderr;
        private int _disposed;

        private ProcessJob(SafeFileHandle job, SafeFileHandle process, StreamReader stdout, StreamReader stderr)
        {
            _job = job;
            _process = process;
            _stdout = stdout;
            _stderr = stderr;
            StartReader(_stdout, "OUT");
            StartReader(_stderr, "ERR");
        }

        public static ProcessJob Launch(string executable, string arguments, string workingDirectory)
        {
            SafeFileHandle job = null;
            SafeFileHandle process = null;
            SafeFileHandle thread = null;
            SafeFileHandle stdoutRead = null;
            SafeFileHandle stdoutWrite = null;
            SafeFileHandle stderrRead = null;
            SafeFileHandle stderrWrite = null;
            SafeFileHandle standardInput = null;
            StreamReader stdout = null;
            StreamReader stderr = null;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr inheritedHandleList = IntPtr.Zero;
            bool attributeListInitialized = false;
            bool processStarted = false;
            bool assignedToJob = false;

            try
            {
                job = CreateJobObject(IntPtr.Zero, null);
                if (job == null || job.IsInvalid)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the process Job Object.");

                ExtendedLimitInformation limits = new ExtendedLimitInformation();
                limits.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                    (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not configure safe Job Object cleanup.");

                SecurityAttributes security = new SecurityAttributes();
                security.Length = Marshal.SizeOf(typeof(SecurityAttributes));
                security.InheritHandle = 1;
                if (!CreatePipe(out stdoutRead, out stdoutWrite, ref security, 0)
                    || !CreatePipe(out stderrRead, out stderrWrite, ref security, 0))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create process output pipes.");

                if (!SetHandleInformation(stdoutRead, HandleFlagInherit, 0)
                    || !SetHandleInformation(stderrRead, HandleFlagInherit, 0))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not secure process output pipes.");

                standardInput = CreateFile("NUL", GenericRead, FileShareRead | FileShareWrite,
                    ref security, OpenExisting, FileAttributeNormal, IntPtr.Zero);
                if (standardInput == null || standardInput.IsInvalid)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not open a safe null input handle.");

                IntPtr attributeListSize = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
                attributeList = Marshal.AllocHGlobal(attributeListSize);
                if (!InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not initialize process handle inheritance.");
                attributeListInitialized = true;

                inheritedHandleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(inheritedHandleList, 0, standardInput.DangerousGetHandle());
                Marshal.WriteIntPtr(inheritedHandleList, IntPtr.Size, stdoutWrite.DangerousGetHandle());
                Marshal.WriteIntPtr(inheritedHandleList, IntPtr.Size * 2, stderrWrite.DangerousGetHandle());
                if (!UpdateProcThreadAttribute(attributeList, 0, HandleListAttribute,
                    inheritedHandleList, new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not restrict inherited process handles.");

                StartupInfo startup = new StartupInfo();
                startup.Size = Marshal.SizeOf(typeof(StartupInfoEx));
                startup.Flags = StartfUseStdHandles;
                startup.StandardInput = standardInput.DangerousGetHandle();
                startup.StandardOutput = stdoutWrite.DangerousGetHandle();
                startup.StandardError = stderrWrite.DangerousGetHandle();
                StartupInfoEx startupEx = new StartupInfoEx();
                startupEx.StartupInfo = startup;
                startupEx.AttributeList = attributeList;

                ProcessInformation information;
                StringBuilder commandLine = new StringBuilder(QuoteArgument(executable) + " " + arguments);
                bool created = CreateProcess(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
                    CreateSuspended | CreateNoWindow | ExtendedStartupInfoPresent, IntPtr.Zero,
                    workingDirectory, ref startupEx, out information);
                int createProcessError = created ? 0 : Marshal.GetLastWin32Error();
                DeleteProcThreadAttributeList(attributeList);
                attributeListInitialized = false;
                Marshal.FreeHGlobal(attributeList);
                attributeList = IntPtr.Zero;
                Marshal.FreeHGlobal(inheritedHandleList);
                inheritedHandleList = IntPtr.Zero;
                standardInput.Dispose();
                standardInput = null;
                if (!created)
                    throw new Win32Exception(createProcessError,
                        "CreateProcessW failed for the suspended launcher before Job Object assignment ("
                        + createProcessError + ", 0x" + createProcessError.ToString("X8") + ").");

                processStarted = true;
                process = new SafeFileHandle(information.Process, true);
                thread = new SafeFileHandle(information.Thread, true);

                stdoutWrite.Dispose();
                stdoutWrite = null;
                stderrWrite.Dispose();
                stderrWrite = null;

                if (!AssignProcessToJobObject(job, process))
                {
                    int assignError = Marshal.GetLastWin32Error();
                    throw new Win32Exception(assignError,
                        "AssignProcessToJobObject failed (" + assignError + ", 0x" + assignError.ToString("X8")
                        + "); the suspended launcher will be terminated before returning.");
                }
                assignedToJob = true;

                stdout = new StreamReader(new FileStream(stdoutRead, FileAccess.Read, 4096, false), Encoding.UTF8, true);
                stdoutRead = null;
                stderr = new StreamReader(new FileStream(stderrRead, FileAccess.Read, 4096, false), Encoding.UTF8, true);
                stderrRead = null;

                uint resumeResult = ResumeThread(thread);
                if (resumeResult == 0xffffffff)
                {
                    int resumeError = Marshal.GetLastWin32Error();
                    throw new Win32Exception(resumeError,
                        "ResumeThread failed after Job Object assignment (" + resumeError + ", 0x"
                        + resumeError.ToString("X8") + "); closing the job will terminate the suspended launcher.");
                }

                thread.Dispose();
                thread = null;

                ProcessJob result = new ProcessJob(job, process, stdout, stderr);
                job = null;
                process = null;
                stdout = null;
                stderr = null;
                return result;
            }
            catch (Exception launchError)
            {
                Exception cleanupError = null;
                try
                {
                    if (job != null)
                    {
                        job.Dispose();
                        job = null;
                    }
                    if (processStarted && process != null && !process.IsInvalid)
                    {
                        bool terminated = assignedToJob || TerminateProcess(process, 1);
                        int terminateError = terminated ? 0 : Marshal.GetLastWin32Error();
                        if (!terminated && WaitForSingleObject(process, 0) != WaitObject0)
                        {
                            throw new Win32Exception(terminateError,
                                "TerminateProcess could not stop the suspended unassigned launcher ("
                                + terminateError + ", 0x" + terminateError.ToString("X8") + ").");
                        }
                        uint waitResult = WaitForSingleObject(process, uint.MaxValue);
                        if (waitResult == WaitFailed)
                        {
                            int waitError = Marshal.GetLastWin32Error();
                            throw new Win32Exception(waitError,
                                "Could not confirm termination of the failed launcher ("
                                + waitError + ", 0x" + waitError.ToString("X8") + ").");
                        }
                    }
                }
                catch (Exception error)
                {
                    cleanupError = error;
                }
                finally
                {
                    DisposeHandle(stdout);
                    DisposeHandle(stderr);
                    DisposeHandle(process);
                    DisposeHandle(thread);
                    DisposeHandle(stdoutRead);
                    DisposeHandle(stdoutWrite);
                    DisposeHandle(stderrRead);
                    DisposeHandle(stderrWrite);
                    DisposeHandle(standardInput);
                    if (attributeListInitialized && attributeList != IntPtr.Zero)
                        DeleteProcThreadAttributeList(attributeList);
                    if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
                    if (inheritedHandleList != IntPtr.Zero) Marshal.FreeHGlobal(inheritedHandleList);
                }
                if (cleanupError != null)
                    throw new AggregateException("Process launch failed and cleanup reported an additional error.",
                        launchError, cleanupError);
                throw;
            }
        }

        public bool IsExited
        {
            get
            {
                if (_process == null || _process.IsInvalid || _process.IsClosed) return true;
                return WaitForSingleObject(_process, 0) == 0;
            }
        }

        public uint ExitCode
        {
            get
            {
                uint code;
                if (_process == null || !GetExitCodeProcess(_process, out code))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not read the launcher exit code.");
                return code;
            }
        }

        public string[] DrainLogs()
        {
            lock (_logLock)
            {
                string[] result = _logs.ToArray();
                _logs.Clear();
                return result;
            }
        }

        public void AddLog(string message)
        {
            AddLogLine("INFO", message);
        }

        private void StartReader(StreamReader reader, string streamName)
        {
            Thread worker = new Thread(delegate()
            {
                StringBuilder line = new StringBuilder();
                char[] buffer = new char[1024];
                try
                {
                    int count;
                    while ((count = reader.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        for (int index = 0; index < count; index++)
                        {
                            char character = buffer[index];
                            if (character == '\n')
                            {
                                AddLogLine(streamName, line.ToString().TrimEnd('\r'));
                                line.Length = 0;
                            }
                            else if (line.Length < MaxLogLineLength)
                            {
                                line.Append(character);
                            }
                        }
                    }
                    if (line.Length > 0) AddLogLine(streamName, line.ToString().TrimEnd('\r'));
                }
                catch (IOException) { }
                catch (ObjectDisposedException) { }
            });
            worker.IsBackground = true;
            worker.Start();
        }

        private void AddLogLine(string streamName, string message)
        {
            string line = DateTime.Now.ToString("HH:mm:ss") + " [" + streamName + "] " + message;
            lock (_logLock)
            {
                while (_logs.Count >= LogCapacity) _logs.Dequeue();
                _logs.Enqueue(line);
            }
        }

        private static void DisposeHandle(IDisposable handle)
        {
            if (handle != null) handle.Dispose();
        }

        private static string QuoteArgument(string value)
        {
            StringBuilder quoted = new StringBuilder();
            quoted.Append('"');
            int backslashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    backslashes++;
                }
                else if (character == '"')
                {
                    quoted.Append('\\', backslashes * 2 + 1);
                    quoted.Append('"');
                    backslashes = 0;
                }
                else
                {
                    quoted.Append('\\', backslashes);
                    quoted.Append(character);
                    backslashes = 0;
                }
            }
            quoted.Append('\\', backslashes * 2);
            quoted.Append('"');
            return quoted.ToString();
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0) return;

            Exception cleanupError = null;
            try
            {
                if (_job != null)
                {
                    _job.Dispose();
                    _job = null;
                }
                if (_process != null)
                {
                    uint waitResult = WaitForSingleObject(_process, uint.MaxValue);
                    if (waitResult == WaitFailed)
                    {
                        int waitError = Marshal.GetLastWin32Error();
                        throw new Win32Exception(waitError,
                            "WaitForSingleObject failed while confirming owned launcher shutdown ("
                            + waitError + ", 0x" + waitError.ToString("X8") + ").");
                    }
                    if (waitResult != WaitObject0)
                        throw new InvalidOperationException("The owned launcher did not signal termination after its Job Object closed.");
                }
            }
            catch (Exception error)
            {
                cleanupError = error;
            }
            finally
            {
                DisposeHandle(_process);
                _process = null;
                DisposeHandle(_stdout);
                _stdout = null;
                DisposeHandle(_stderr);
                _stderr = null;
            }
            if (cleanupError != null) throw cleanupError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SecurityAttributes
        {
            public int Length;
            public IntPtr SecurityDescriptor;
            public int InheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public int Size;
            public string Reserved;
            public string Desktop;
            public string Title;
            public int X;
            public int Y;
            public int XSize;
            public int YSize;
            public int XCountChars;
            public int YCountChars;
            public int FillAttribute;
            public uint Flags;
            public short ShowWindow;
            public short Reserved2;
            public IntPtr Reserved2Pointer;
            public IntPtr StandardInput;
            public IntPtr StandardOutput;
            public IntPtr StandardError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfoEx
        {
            public StartupInfo StartupInfo;
            public IntPtr AttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr Process;
            public IntPtr Thread;
            public uint ProcessId;
            public uint ThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct BasicLimitInformation
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IoCounters
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ExtendedLimitInformation
        {
            public BasicLimitInformation BasicLimitInformation;
            public IoCounters IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass,
            ref ExtendedLimitInformation information, uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CreatePipe(out SafeFileHandle readPipe, out SafeFileHandle writePipe,
            ref SecurityAttributes attributes, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(SafeFileHandle handle, uint mask, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(string applicationName, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
            IntPtr environment, string currentDirectory, ref StartupInfoEx startupInfo,
            out ProcessInformation processInformation);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(string fileName, uint desiredAccess, uint shareMode,
            ref SecurityAttributes securityAttributes, uint creationDisposition, uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int attributeCount,
            uint flags, ref IntPtr size);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute,
            IntPtr value, UIntPtr attributeSize, IntPtr previousValue, IntPtr returnSize);

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeFileHandle process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(SafeFileHandle thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(SafeFileHandle process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(SafeFileHandle process, out uint exitCode);
    }
}
