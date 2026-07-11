// Kaspa Safe — replacement for the generated MainActivity (CI copies it over after `tauri android init`).
// The default Tauri template calls enableEdgeToEdge() WITHOUT handling insets → the whole header
// slides under the status bar and taps hit the system shade. Edge-to-edge stays enabled here
// (on targetSdk 36 / Android 15+ it is mandatory), but the content is padded by the size of the
// system bars + display cutout, and the area under the bars is painted the site color (#0E1116, light icons).
package co.officeforge.kaspasafe

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      SystemBarStyle.dark(Color.TRANSPARENT),
      SystemBarStyle.dark(Color.TRANSPARENT)
    )
    super.onCreate(savedInstanceState)
    val root = findViewById<View>(android.R.id.content)
    root.setBackgroundColor(Color.parseColor("#FF0E1116"))
    ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }
}
