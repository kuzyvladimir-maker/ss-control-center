# Persistent loopback bridge: reads ONLY the Salutem Seller Central inbox tab.
# Keeps Chrome's explicitly allowed debugging connection alive between scans.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$ws=$null
$sessionId=$null
$cts=New-Object System.Threading.CancellationTokenSource
function Send-Cdp($cmd) {
  $bytes=[Text.Encoding]::UTF8.GetBytes(($cmd | ConvertTo-Json -Compress -Depth 30))
  $null=$ws.SendAsync([ArraySegment[byte]]::new($bytes),[System.Net.WebSockets.WebSocketMessageType]::Text,$true,$cts.Token).GetAwaiter().GetResult()
  do {
    $stream=New-Object IO.MemoryStream
    do {
      $buffer=New-Object byte[] 65536
      $r=$ws.ReceiveAsync([ArraySegment[byte]]::new($buffer),$cts.Token).GetAwaiter().GetResult()
      $stream.Write($buffer,0,$r.Count)
    } while (!$r.EndOfMessage)
    $msg=[Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
  } while ($msg.id -ne $cmd.id)
  return $msg
}
$listener=New-Object Net.HttpListener
$listener.Prefixes.Add('http://127.0.0.1:9230/')
$listener.Start()
try {
 while ($listener.IsListening) {
  $ctx=$listener.GetContext()
  try {
   if ($ctx.Request.HttpMethod -ne 'POST') {throw 'POST required'}
   $command=(New-Object IO.StreamReader($ctx.Request.InputStream)).ReadToEnd() | ConvertFrom-Json
   if ($command.method -notin @('Runtime.evaluate','Page.navigate','Page.captureScreenshot')) {throw 'Unsupported scan operation'}
   $cts.CancelAfter(120000)
   if (!$ws -or $ws.State -ne [Net.WebSockets.WebSocketState]::Open) {
    $port=Get-Content 'C:\Users\Administrator\AppData\Local\Google\Chrome\User Data\DevToolsActivePort'
    $ws=New-Object Net.WebSockets.ClientWebSocket
    $null=$ws.ConnectAsync([Uri]("ws://127.0.0.1:"+$port[0]+$port[1]),$cts.Token).GetAwaiter().GetResult()
    $sessionId=$null
   }
   if (!$sessionId) {
    $created=Send-Cdp @{id=100;method='Target.createTarget';params=@{url='https://sellercentral.amazon.com/messaging/inbox';background=$true}}
    if (!$created.result.targetId) {throw 'Cannot create dedicated scan tab'}
    $attach=Send-Cdp @{id=101;method='Target.attachToTarget';params=@{targetId=$created.result.targetId;flatten=$true}}
    $sessionId=$attach.result.sessionId
   }
   $command | Add-Member -NotePropertyName sessionId -NotePropertyValue $sessionId
   $result=Send-Cdp $command | ConvertTo-Json -Compress -Depth 40
   $cts.CancelAfter(-1)
   $ctx.Response.StatusCode=200
  } catch {
   $result=@{error=$_.Exception.Message} | ConvertTo-Json -Compress
   $ctx.Response.StatusCode=500
   if ($ws) {$ws.Dispose()};$ws=$null;$sessionId=$null
   $cts.Dispose();$cts=New-Object System.Threading.CancellationTokenSource
  }
  $bytes=[Text.Encoding]::UTF8.GetBytes($result)
  $ctx.Response.ContentType='application/json'
  # A timed-out/disconnected HTTP caller must not kill the persistent bridge.
  try {$ctx.Response.OutputStream.Write($bytes,0,$bytes.Length)} catch {}
  try {$ctx.Response.Close()} catch {}
 }
} finally {if ($ws) {$ws.Dispose()};$listener.Close();$cts.Dispose()}
