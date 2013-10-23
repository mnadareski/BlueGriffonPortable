""" GDB Python customization auto-loader for js shell """

import os.path
sys.path[0:0] = [os.path.join('c:/trees/official1.7/js/src', 'gdb')]

import mozilla.autoload
mozilla.autoload.register(gdb.current_objfile())
