package dev.lastseen.probe

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Task 6d. A foreground service with the camera and microphone types and a persistent "Lastseen running" notification.
 *
 * Android 14 rules this exercises: the types must be declared in the manifest, the matching FOREGROUND_SERVICE_*
 * permissions must be declared, CAMERA / RECORD_AUDIO must already be GRANTED at startForeground() time (else
 * SecurityException), and the app must be in the foreground when it starts (else ForegroundServiceStartNotAllowedException).
 */
class ProbeForegroundService : Service() {
    companion object {
        const val CHANNEL = "lastseen_running"
        const val NOTIFICATION_ID = 4101
        const val ACTION_STOP = "dev.lastseen.probe.STOP_PROBE_SERVICE"

        @Volatile var running = false
        @Volatile var startedAtMs = 0L
        @Volatile var lastError: String? = null
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        try {
            ensureChannel()
            val notification = buildNotification()
            if (Build.VERSION.SDK_INT >= 30) { // the camera and microphone service types exist from API 30
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
                )
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
            running = true
            startedAtMs = System.currentTimeMillis()
            lastError = null
            Log.i(TAG, "foreground service started (camera|microphone)")
        } catch (t: Throwable) {
            running = false
            lastError = t.toString()
            Log.e(TAG, "foreground service failed to start", t)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running = false
        Log.i(TAG, "foreground service stopped")
        super.onDestroy()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Lastseen running", NotificationManager.IMPORTANCE_LOW))
        }
    }

    private fun buildNotification(): Notification {
        val stop = PendingIntent.getService(
            this, 0,
            Intent(this, ProbeForegroundService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val open = PendingIntent.getActivity(
            this, 1,
            Intent(this, ProbeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Lastseen running")
            .setContentText("Camera and microphone service (hardware probe)")
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .build()
    }
}
