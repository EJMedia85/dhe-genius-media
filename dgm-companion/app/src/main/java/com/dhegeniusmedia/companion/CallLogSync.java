package com.dhegeniusmedia.companion;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.provider.CallLog;
import android.provider.ContactsContract;
import android.net.Uri;
import org.json.JSONObject;

public final class CallLogSync {
    private CallLogSync() {}

    public static boolean hasAccess(Context context) {
        return android.os.Build.VERSION.SDK_INT < 23 ||
            context.checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED;
    }

    public static boolean hasContactsAccess(Context context) {
        return android.os.Build.VERSION.SDK_INT < 23 ||
            context.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
    }

    public static void syncRecent(Context context) {
        if (!hasAccess(context)) return;

        Cursor c = null;
        try {
            c = context.getContentResolver().query(
                CallLog.Calls.CONTENT_URI,
                new String[]{
                    CallLog.Calls._ID,
                    CallLog.Calls.NUMBER,
                    CallLog.Calls.TYPE,
                    CallLog.Calls.DATE,
                    CallLog.Calls.DURATION,
                    CallLog.Calls.CACHED_NAME
                },
                null, null,
                CallLog.Calls.DATE + " DESC"
            );
            if (c == null) return;

            int idCol = c.getColumnIndex(CallLog.Calls._ID);
            int numberCol = c.getColumnIndex(CallLog.Calls.NUMBER);
            int typeCol = c.getColumnIndex(CallLog.Calls.TYPE);
            int dateCol = c.getColumnIndex(CallLog.Calls.DATE);
            int durationCol = c.getColumnIndex(CallLog.Calls.DURATION);
            int cachedNameCol = c.getColumnIndex(CallLog.Calls.CACHED_NAME);

            int count = 0;
            while (c.moveToNext() && count < 100) {
                String id = idCol >= 0 ? c.getString(idCol) : String.valueOf(System.currentTimeMillis());
                String number = numberCol >= 0 ? c.getString(numberCol) : "";
                String name = cachedNameCol >= 0 ? c.getString(cachedNameCol) : "";

                if ((name == null || name.trim().isEmpty()) && hasContactsAccess(context)
                        && number != null && !number.trim().isEmpty()) {
                    name = lookupContactName(context, number);
                }
                if (name == null) name = "";

                // Android's CallLog.Calls does not expose UNKNOWN_TYPE.
                // A missing/invalid type column is represented locally as 0.
                int type = typeCol >= 0 ? c.getInt(typeCol) : 0;
                long date = dateCol >= 0 ? c.getLong(dateCol) : 0L;
                long duration = durationCol >= 0 ? c.getLong(durationCol) : 0L;

                JSONObject meta = new JSONObject();
                meta.put("source", "android_call_log");
                meta.put("call_id", id);
                meta.put("phone_number", number == null ? "" : number);
                meta.put("contact_name", name);
                meta.put("call_type", callTypeName(type));
                meta.put("call_type_code", type);
                meta.put("timestamp", date);
                meta.put("duration_seconds", duration);

                String sender = name.trim().isEmpty() ? (number == null ? "" : number) : name;
                String body = callTypeName(type) + " call"
                    + (number == null || number.isEmpty() ? "" : " • " + number)
                    + (duration > 0 ? " • " + duration + "s" : "");

                DgmApi.sendMessage(context, "call_log", sender, body, "call-" + id, meta);
                count++;
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
    }

    private static String lookupContactName(Context context, String number) {
        Cursor c = null;
        try {
            Uri uri = Uri.withAppendedPath(
                ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
                Uri.encode(number)
            );
            c = context.getContentResolver().query(
                uri,
                new String[]{ContactsContract.PhoneLookup.DISPLAY_NAME},
                null, null, null
            );
            if (c != null && c.moveToFirst()) {
                int col = c.getColumnIndex(ContactsContract.PhoneLookup.DISPLAY_NAME);
                if (col >= 0) {
                    String name = c.getString(col);
                    return name == null ? "" : name;
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return "";
    }

    private static String callTypeName(int type) {
        switch (type) {
            case CallLog.Calls.INCOMING_TYPE: return "Incoming";
            case CallLog.Calls.OUTGOING_TYPE: return "Outgoing";
            case CallLog.Calls.MISSED_TYPE: return "Missed";
            case CallLog.Calls.REJECTED_TYPE: return "Rejected";
            case CallLog.Calls.BLOCKED_TYPE: return "Blocked";
            case CallLog.Calls.VOICEMAIL_TYPE: return "Voicemail";
            case CallLog.Calls.ANSWERED_EXTERNALLY_TYPE: return "Answered externally";
            default: return "Unknown";
        }
    }
}
