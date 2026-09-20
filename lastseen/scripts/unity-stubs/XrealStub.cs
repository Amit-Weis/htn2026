// Compile-only stand-in for the few XREAL SDK types the project scripts use, so scripts/unity-check.mjs can build them in a scratch
// project that does not have the (tarball) com.xreal.xr package. The definitions are copied from
// Packages/com.xreal.xr/Runtime/Scripts/XREALPlugin.cs and XREALCallbackHandler.cs. If the SDK changes them, change this to match.
#pragma warning disable CS0067
namespace Unity.XR.XREAL
{
    public enum XREALKeyType
    {
        NONE = 0,
        MULTI_KEY = 1,
        INCREASE_KEY = 2,
        DECREASE_KEY = 3,
        MENU_KEY = 4,
        ALL_KEY = 1000,
    }

    public enum XREALClickType
    {
        CLICK = 1,
        DOUBLE_CLICK = 2,
        LONG_PRESS = 3,
    }

    public delegate void XREALGlassesKeyClickCallback(XREALClickType actionType, XREALKeyType keyType);

    public static class XREALCallbackHandler
    {
        public static event XREALGlassesKeyClickCallback OnXREALGlassesKeyClick;
    }
}
