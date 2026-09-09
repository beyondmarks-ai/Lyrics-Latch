package ai.beyondmarks.lyriclatch

import android.annotation.SuppressLint
import android.content.Context
import ai.beyondmarks.lyriclatch.commands.CommandEngine
import ai.beyondmarks.lyriclatch.data.ConfigStore
import ai.beyondmarks.lyriclatch.lyrics.SectionLooper
import ai.beyondmarks.lyriclatch.net.CloudServices
import ai.beyondmarks.lyriclatch.spotify.SpotifyAuth
import ai.beyondmarks.lyriclatch.spotify.SpotifyController

@SuppressLint("StaticFieldLeak")
object AppGraph {
    @Volatile private var initialized = false
    lateinit var store: ConfigStore
        private set
    lateinit var auth: SpotifyAuth
        private set
    lateinit var cloud: CloudServices
        private set
    lateinit var spotify: SpotifyController
        private set
    lateinit var looper: SectionLooper
        private set
    lateinit var commands: CommandEngine
        private set

    fun initialize(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            store = ConfigStore.get(context)
            auth = SpotifyAuth(store)
            cloud = CloudServices(store)
            spotify = SpotifyController(context.applicationContext, store, auth)
            looper = SectionLooper(spotify, cloud)
            commands = CommandEngine(spotify, cloud, looper)
            initialized = true
        }
    }
}
