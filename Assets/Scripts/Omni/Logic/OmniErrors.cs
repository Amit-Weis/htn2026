using System;

namespace Omni
{
    public enum FailureKind
    {
        NoConnection,
        Timeout,
        Token,
        Server,
        BadRequest,
        BadReply,
    }

    /// <summary>Why a call to the Worker failed, in three forms: what kind, what to show, and what to say aloud.</summary>
    public sealed class Failure
    {
        public FailureKind Kind;
        /// <summary>for the screen, with detail</summary>
        public string Status = "";
        /// <summary>a short sentence for the wearer, who is probably not reading the screen</summary>
        public string Spoken = "";
        /// <summary>true when the problem is Omni or the network (worth working around), false for a settings or code problem the wearer must hear about</summary>
        public bool OmniUnavailable;
    }

    /// <summary>Turns an HTTP outcome into a <see cref="Failure"/>. Pure, so every case is unit-tested.</summary>
    public static class OmniErrors
    {
        const int MaxBody = 160;

        public static Failure Classify(long responseCode, string error, string body)
        {
            string detail = Trim(body);
            if (responseCode == 401 || responseCode == 403)
                return Make(FailureKind.Token, "the Worker rejected the token (check token in lastseen.json)", "The token was rejected. Check the settings.", false);
            if (responseCode == 429)
                return Make(FailureKind.Server, "HTTP 429: Omni is over its limit or rate limited", "Omni is over its limit.", true);
            if (responseCode >= 500)
                return Make(FailureKind.Server, "HTTP " + responseCode + ": " + detail, "Omni had a problem.", true);
            if (responseCode >= 400)
                return Make(FailureKind.BadRequest, "HTTP " + responseCode + ": " + detail, "The request was rejected.", false);

            string e = error ?? "";
            if (e.IndexOf("timeout", StringComparison.OrdinalIgnoreCase) >= 0 || e.IndexOf("timed out", StringComparison.OrdinalIgnoreCase) >= 0)
                return Make(FailureKind.Timeout, "no answer in time (" + e + ")", "Omni took too long.", true);
            return Make(FailureKind.NoConnection, "no connection (" + e + ")", "I couldn't reach Omni. Check the network.", true);
        }

        public static Failure BadReply(string body)
        {
            return Make(FailureKind.BadReply, "the Worker's reply was not understood: " + Trim(body), "I couldn't understand Omni's reply.", false);
        }

        static Failure Make(FailureKind kind, string status, string spoken, bool omniUnavailable)
        {
            return new Failure { Kind = kind, Status = status, Spoken = spoken, OmniUnavailable = omniUnavailable };
        }

        static string Trim(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Length > MaxBody ? s.Substring(0, MaxBody) + "..." : s;
        }
    }
}
