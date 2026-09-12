console.log( "===== simpread option labs:Speech load =====" )

import { storage } from 'storage';
import { browser } from 'browser';
import * as msg    from 'message';
import * as edgetts from 'edgetts';

import Notify      from 'notify';
import Button      from 'button';
import SelectField from 'selectfield';

/**
 * Read aloud settings.
 *
 * Lives on `secret` rather than `option` — not because a voice name is a secret, but
 * because Safe() migrates a new key onto installs that predate it, while option/read are
 * key counted by Verify() and would report a mismatch instead. @see service/storage.js
 *
 * The 试听 button is the reason this panel is worth its space. edge-tts talks over a
 * websocket to speech.platform.bing.com, and a proxy or firewall that passes ordinary
 * HTTPS to that host may still refuse the upgrade; when that happens the reader needs to
 * find out here, once, rather than by pressing 朗读 and wondering. @see service/speech.js
 */

const ENGINES = [
    { value: "edge",  name: "微软在线语音（edge-tts）" },
    { value: "local", name: "系统语音（离线）" },
];

const RATES = [
    { value: "-50%",  name: "0.5 倍速" },
    { value: "-25%",  name: "0.75 倍速" },
    { value: "+0%",   name: "正常语速" },
    { value: "+25%",  name: "1.25 倍速" },
    { value: "+50%",  name: "1.5 倍速" },
    { value: "+100%", name: "2 倍速" },
];

const SAMPLE = "简悦的语音朗读已经就绪，这是一段用于试听的示例文本。";

const nameOf = ( value, items ) => {
    const hit = items.find( item => item.value == value );
    return hit ? hit.name : value;
};

export default class Speech extends React.Component {

    state = {
        settings: undefined,
        playing : false,
    }

    /**
     * @return {object} the stored settings, with every key present
     */
    current() {
        return { ...edgetts.DEFAULT, engine: "edge", ...( ( storage.secret || {} ).edgetts || {} ) };
    }

    onChange( key, value ) {
        storage.secret.edgetts = { ...this.current(), [key]: value };
        storage.Safe( () => this.setState({ settings: this.current() }), storage.secret );
    }

    /**
     * Speak one sample sentence with the settings as they stand.
     *
     * The options page is an extension page, so it can just play the MP3 itself — no
     * content script, no host CSP. Failures are reported verbatim: "握手被拒绝" is the
     * whole diagnosis when a network blocks the endpoint, and paraphrasing it into
     * "朗读失败" would throw that away.
     */
    preview() {
        const settings = this.current();
        if ( this.state.playing ) return;

        if ( settings.engine == "local" ) {
            browser.tts.speak( SAMPLE, { rate: 1 } );
            return;
        }

        this.setState({ playing: true });
        const notify = new Notify().Render({ content: "正在合成语音，请稍候…", state: "loading" }),
              done   = () => { notify.complete(); this.setState({ playing: false }); };

        browser.runtime.sendMessage(
            msg.Add( msg.MESSAGE_ACTION.speak_synth, { text: SAMPLE, voice: settings.voice, rate: settings.rate }),
            result => {
                if ( browser.runtime.lastError || !result || !result.done ) {
                    done();
                    const why = browser.runtime.lastError ? browser.runtime.lastError.message
                                                          : ( result && result.fail && result.fail.message );
                    new Notify().Render({ type: 2, state: "holdon",
                        content: `${ why || "试听失败。" }<br>如果反复出现，请把「语音引擎」改为<b>系统语音</b>。` });
                    return;
                }
                const binary = atob( result.done.audio ),
                      bytes  = new Uint8Array( binary.length );
                for ( let i = 0; i < binary.length; i++ ) bytes[i] = binary.charCodeAt( i );
                const context = new ( window.AudioContext || window.webkitAudioContext )();
                context.decodeAudioData( bytes.buffer ).then( buffer => {
                    const source = context.createBufferSource();
                    source.buffer = buffer;
                    source.connect( context.destination );
                    source.onended = () => { done(); context.close(); };
                    source.start();
                }).catch( error => {
                    done();
                    new Notify().Render( 2, `音频解码失败：${ error.message }` );
                });
            });
    }

    componentDidMount() {
        storage.Safe( () => this.setState({ settings: this.current() }) );
    }

    render() {
        const settings = this.state.settings;
        if ( !settings ) return <div className="lab"></div>;

        const online = settings.engine != "local";

        return (
            <div style={{ 'padding-top': '10px', 'position': 'relative' }} className="lab">
                <SelectField width="100%" waves="md-waves-effect"
                    floatingtext="语音引擎" placeholder="语音引擎"
                    name={ nameOf( settings.engine, ENGINES ) }
                    items={ ENGINES }
                    onChange={ value => this.onChange( "engine", value ) } />
                <div className="sublabel">微软在线语音音质更好，需要联网；当它连不上时，朗读会自动改用系统语音继续。</div>

                <SelectField width="100%" waves="md-waves-effect"
                    disable={ !online }
                    floatingtext="音色" placeholder="音色"
                    name={ nameOf( settings.voice, edgetts.VOICES ) }
                    items={ edgetts.VOICES }
                    onChange={ value => this.onChange( "voice", value ) } />
                <div className="sublabel">仅对微软在线语音有效；系统语音使用操作系统自带的音色。</div>

                <SelectField width="100%" waves="md-waves-effect"
                    floatingtext="语速" placeholder="语速"
                    name={ nameOf( settings.rate, RATES ) }
                    items={ RATES }
                    onChange={ value => this.onChange( "rate", value ) } />

                <div style={{ 'padding-top': '20px' }}>
                    <Button type="raised" width="100%" style={{ "margin": "0" }}
                        text={ this.state.playing ? "试听中…" : "试 听" }
                        color="#fff" backgroundColor="#3F51B5"
                        waves="md-waves-effect md-waves-button"
                        onClick={ () => this.preview() } />
                </div>
                <div className="sublabel">进入阅读模式后，用控制栏的「无障碍 → 朗读 / 暂停」开始，再点一次暂停，「停止朗读」结束。</div>
            </div>
        )
    }
}
