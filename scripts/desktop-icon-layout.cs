// Documented Shell COM interfaces; vtable order follows Microsoft's shobjidl_core.h.
// https://devblogs.microsoft.com/oldnewthing/20130318-00/?p=4933
// https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/ShObjIdl_core.h
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class HubDesktopIconLayout {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int x; public int y; }
    public class Icon { public int index; public int x; public int y; }
    public class Snapshot { public uint flags; public int spacingX; public int spacingY; public Icon[] icons; }
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int QueryServiceFn(IntPtr self, ref Guid service, ref Guid iid, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutPointerFn(IntPtr self, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CountFn(IntPtr self, uint scope, out int count);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ItemFn(IntPtr self, int index, out IntPtr pidl);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PositionFn(IntPtr self, IntPtr pidl, out Point point);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SpacingFn(IntPtr self, out Point spacing);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetFlagsFn(IntPtr self, out uint flags);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetFlagsFn(IntPtr self, uint mask, uint flags);
    static T Method<T>(IntPtr self, int slot) where T : class {
        return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(self), slot * IntPtr.Size), typeof(T)) as T;
    }
    static void Check(int hr) { Marshal.ThrowExceptionForHR(hr); }
    static IntPtr View(object desktop) {
        IntPtr unknown = IntPtr.Zero, provider = IntPtr.Zero, browser = IntPtr.Zero, shellView = IntPtr.Zero, view = IntPtr.Zero;
        try {
            unknown = Marshal.GetIUnknownForObject(desktop);
            Guid providerId = new Guid("6d5140c1-7436-11ce-8034-00aa006009fa");
            Check(Marshal.QueryInterface(unknown, ref providerId, out provider));
            Guid service = new Guid("4c96be40-915c-11cf-99d3-00aa004ae837"), browserId = new Guid("000214e2-0000-0000-c000-000000000046");
            Check(Method<QueryServiceFn>(provider, 3)(provider, ref service, ref browserId, out browser));
            Check(Method<OutPointerFn>(browser, 15)(browser, out shellView));
            Guid viewId = new Guid("1af3a467-214f-4298-908e-06b03e0b39f9");
            Check(Marshal.QueryInterface(shellView, ref viewId, out view));
            return view;
        } finally {
            foreach (IntPtr value in new IntPtr[] { shellView, browser, provider, unknown }) if (value != IntPtr.Zero) Marshal.Release(value);
        }
    }
    public static Snapshot Read(object desktop) {
        IntPtr view = View(desktop);
        try {
            uint flags; Check(Method<GetFlagsFn>(view, 25)(view, out flags));
            int count; Check(Method<CountFn>(view, 7)(view, 2, out count));
            Point spacing; Check(Method<SpacingFn>(view, 12)(view, out spacing));
            var icons = new List<Icon>();
            for (int i = 0; i < count; i++) {
                IntPtr pidl = IntPtr.Zero;
                try {
                    Check(Method<ItemFn>(view, 6)(view, i, out pidl));
                    Point point; Check(Method<PositionFn>(view, 11)(view, pidl, out point));
                    icons.Add(new Icon { index = i, x = point.x, y = point.y });
                } finally { if (pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(pidl); }
            }
            return new Snapshot { flags = flags, spacingX = spacing.x, spacingY = spacing.y, icons = icons.ToArray() };
        } finally { Marshal.Release(view); }
    }
    public static void Arrange(object desktop) {
        IntPtr view = View(desktop);
        try {
            // Only auto-arrange and left alignment are changed. Other folder flags stay intact.
            const uint mask = 0x1 | 0x800;
            Check(Method<SetFlagsFn>(view, 24)(view, mask, mask));
        } finally { Marshal.Release(view); }
    }
}
